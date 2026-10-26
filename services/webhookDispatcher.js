/**
 * Outbound webhooks (scope 4.3): order.attributed, booking.created / updated / cancelled,
 * refund.created, integration.failing — signed with HMAC and retried.
 *
 * Every delivery is a WebhookDelivery row (Settings → Webhooks → delivery log). Failures retry with
 * backoff (1m, 5m, 30m, 2h, 6h, 12h); after the last attempt the delivery is "failed". An endpoint
 * that fails 10 deliveries in a row is switched off with a reason. Rows survive restarts: the
 * scheduler re-polls due deliveries.
 *
 * Signature headers:
 *   X-Webhook-Id, X-Webhook-Event, X-Webhook-Timestamp (unix seconds)
 *   X-Webhook-Signature-V2: t=<timestamp>,v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>   (verify this one)
 *   X-Webhook-Signature:    <hex HMAC-SHA256(secret, body)>                                       (legacy)
 */

import crypto from "crypto";
import { db } from "../src/prisma/db.js";
import { decryptSecret } from "../utils/crypto.js";
import { enqueueJob, registerJobHandler } from "./jobs.js";

export const WEBHOOK_EVENT_TYPES = ["order.attributed", "order.updated", "booking.created", "booking.updated", "booking.cancelled", "refund.created", "integration.failing", "ping"];
// endpoints created before the rename keep receiving the attributed order event
const LEGACY_ALIASES = { "order.created": "order.attributed" };

const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const MAX_CONSECUTIVE_FAILURES = 10;
const TIMEOUT_MS = 10_000;

const orm = () => db.orm.public;
const hasDeliveryStore = () => {
    try {
        return typeof orm().WebhookDelivery?.where === "function";
    } catch {
        return false;
    }
};

export const subscribes = (endpoint, type) =>
    (endpoint.eventTypes ?? []).some((t) => t === type || t === "*" || LEGACY_ALIASES[t] === type);

export function signatureHeaders(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
    return {
        "X-Webhook-Timestamp": String(timestamp),
        "X-Webhook-Signature": crypto.createHmac("sha256", secret).update(body).digest("hex"),
        "X-Webhook-Signature-V2": `t=${timestamp},v1=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`,
    };
}

async function post(endpoint, event) {
    const body = JSON.stringify(event);
    const secret = decryptSecret(endpoint.signingSecretEnc);
    const res = await fetch(endpoint.url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "AttributionPlatform-Webhook/1.1",
            "X-Webhook-Id": event.id,
            "X-Webhook-Event": event.type,
            ...signatureHeaders(body, secret),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.status;
}

async function recordOutcome(endpoint, ok) {
    const current = await orm().WebhookEndpoint.where({ id: endpoint.id }).first();
    if (!current) return;
    if (ok) {
        if (current.consecutiveFailures) await orm().WebhookEndpoint.where({ id: endpoint.id }).update({ consecutiveFailures: 0 });
        return;
    }
    const failures = (current.consecutiveFailures || 0) + 1;
    const updates = { consecutiveFailures: failures };
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
        updates.isActive = false;
        updates.disabledReason = `Switched off after ${failures} failed deliveries in a row`;
    }
    await orm().WebhookEndpoint.where({ id: endpoint.id }).update(updates);
}

/** Attempt one stored delivery. */
export async function deliver(deliveryId) {
    const d = await orm().WebhookDelivery.where({ id: deliveryId }).first();
    if (!d || d.status !== "pending") return d?.status ?? "missing";
    const endpoint = await orm().WebhookEndpoint.where({ id: d.endpointId, workspaceId: d.workspaceId }).first();
    if (!endpoint || !endpoint.isActive) {
        await orm().WebhookDelivery.where({ id: d.id }).update({ status: "failed", error: "Endpoint is switched off or deleted", nextAttemptAt: null });
        return "failed";
    }
    const attempt = (d.attempts ?? 0) + 1;
    let status = null;
    let error = null;
    try {
        status = await post(endpoint, d.payload);
    } catch (err) {
        error = err?.name === "TimeoutError" ? "Timed out after 10s" : String(err?.message ?? err).slice(0, 300);
    }
    const ok = status !== null && status >= 200 && status < 300;
    // 4xx other than 408/429 will not get better by retrying
    const retryable = !ok && (status === null || status >= 500 || status === 408 || status === 429);
    const final = ok ? "succeeded" : !retryable || attempt >= MAX_ATTEMPTS ? "failed" : "pending";
    await orm()
        .WebhookDelivery.where({ id: d.id })
        .update({
            attempts: attempt,
            responseStatus: status,
            error: ok ? null : error ?? `HTTP ${status}`,
            status: final,
            deliveredAt: ok ? new Date().toISOString() : null,
            nextAttemptAt: final === "pending" ? new Date(Date.now() + RETRY_DELAYS_MS[attempt - 1]).toISOString() : null,
        });
    if (final !== "pending") await recordOutcome(endpoint, ok);
    return final;
}

registerJobHandler("webhook.deliver", ({ deliveryId }) => deliver(deliveryId));

/**
 * Queue an event for every active endpoint of the company that subscribes to it. Never blocks or
 * throws into the caller.
 */
export function dispatchWebhook(workspaceId, eventType, data) {
    void (async () => {
        try {
            const endpoints = (await orm().WebhookEndpoint.where({ workspaceId, isActive: true }).all()).filter((ep) => subscribes(ep, eventType));
            if (!endpoints.length) return;
            const event = { id: `evt_${crypto.randomUUID()}`, type: eventType, createdAt: new Date().toISOString(), workspaceId, data };
            for (const ep of endpoints) {
                if (hasDeliveryStore()) {
                    const row = await orm().WebhookDelivery.create({ workspaceId, endpointId: ep.id, eventId: event.id, eventType, payload: event, status: "pending", attempts: 0, nextAttemptAt: new Date().toISOString() });
                    enqueueJob("webhook.deliver", { workspaceId, deliveryId: row.id });
                } else {
                    // no delivery table yet: best effort, three quick attempts
                    for (let i = 0; i < 3; i++) {
                        try {
                            const status = await post(ep, event);
                            if (status >= 200 && status < 300) break;
                        } catch {
                            /* retry */
                        }
                        await new Promise((r) => setTimeout(r, 1000 * 5 ** i));
                    }
                }
            }
        } catch (err) {
            console.error("dispatchWebhook error:", err.message);
        }
    })();
}

/** Send a test event to one endpoint right now and return what happened. */
export async function sendTestEvent(endpoint) {
    const event = { id: `evt_${crypto.randomUUID()}`, type: "ping", createdAt: new Date().toISOString(), workspaceId: endpoint.workspaceId, data: { message: "Test event from the attribution platform" } };
    if (hasDeliveryStore()) {
        const row = await orm().WebhookDelivery.create({ workspaceId: endpoint.workspaceId, endpointId: endpoint.id, eventId: event.id, eventType: "ping", payload: event, status: "pending", attempts: 0 });
        const status = await deliver(row.id);
        const after = await orm().WebhookDelivery.where({ id: row.id }).first();
        return { deliveryId: row.id, status, responseStatus: after?.responseStatus ?? null, error: after?.error ?? null };
    }
    try {
        const code = await post(endpoint, event);
        return { status: code >= 200 && code < 300 ? "succeeded" : "failed", responseStatus: code };
    } catch (err) {
        return { status: "failed", error: err.message };
    }
}

/** Scheduler tick: retry due deliveries (also picks up rows left by a restart). */
export async function pollDueDeliveries(limit = 200) {
    if (!hasDeliveryStore()) return 0;
    const now = Date.now();
    const rows = (await orm().WebhookDelivery.where({ status: "pending" }).all()).filter((d) => !d.nextAttemptAt || new Date(d.nextAttemptAt).getTime() <= now).slice(0, limit);
    for (const d of rows) enqueueJob("webhook.deliver", { workspaceId: d.workspaceId, deliveryId: d.id });
    return rows.length;
}
