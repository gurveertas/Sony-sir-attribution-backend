/**
 * Inbound event queue (scope 4.12): acknowledge fast, process asynchronously, at least once.
 *
 *   webhook ─► verify signature ─► save RawEvent (status "pending")  ─► 200 to the gateway
 *                                       │
 *                         background worker (per company, in order)
 *                                       │
 *              processed ◄── processor ok        processor failed ──► "failed" + nextAttemptAt
 *                                                (exponential backoff: 30s, 1m, 2m … 1h)
 *                                                after MAX_ATTEMPTS ──► "dead" (dead-letter queue)
 *
 * The RawEvent row IS the queue: a restart loses nothing, the scheduler re-polls pending/failed rows
 * whose nextAttemptAt has passed. Processing is idempotent (orders/refunds/bookings dedupe on the
 * provider's ids), so at-least-once delivery never double-counts.
 */

import { db } from "../src/prisma/db.js";
import { enqueueJob, registerJobHandler } from "./jobs.js";
import { processConnectorEvent } from "./connectorProcessors.js";
import { markConnectorFailure, markConnectorSuccess, touchLastEvent } from "./connectorRuntime.js";
import { dispatchWebhook } from "./webhookDispatcher.js";

export const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 3_600_000;
const STALE_PENDING_MS = 60_000;

const orm = () => db.orm.public;
export const backoffMs = (attempt) => Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));

/** Validation-type failures will not fix themselves; anything else (not found yet, network) is retried. */
const isPermanent = (err) => {
    const status = Number(err?.statusCode);
    if (status === 404) return false; // refund before its order, update before its booking: wait
    if (status >= 400 && status < 500) return true;
    return /\(4(?!04)\d\d\)/.test(String(err?.message ?? ""));
};

/**
 * Save a verified event and queue it. Throws when the event could not be stored — the caller must
 * then answer 5xx so the sender retries (an event is never acknowledged before it is stored).
 */
export async function acceptEvent({ workspaceId, connector = null, source, eventType, payload, isTest = false, idempotencyKey = null }) {
    const raw = await orm().RawEvent.create({
        workspaceId,
        connectorId: connector?.id ?? null,
        source,
        eventType: String(eventType || "unknown").slice(0, 200),
        payload,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date().toISOString(),
        idempotencyKey,
        isTest: Boolean(isTest),
    });
    if (connector) touchLastEvent(connector.id);
    enqueueJob("event.process", { workspaceId, rawEventId: raw.id });
    return raw;
}

async function runProcessor(raw, connector) {
    if (connector) {
        return processConnectorEvent({ connector, eventType: raw.eventType, payload: raw.payload, receivedAt: raw.receivedAt, isTest: raw.isTest });
    }
    // events received through the public API (source "api")
    const { processApiEvent } = await import("./apiEvents.js");
    return processApiEvent(raw);
}

/**
 * Process one stored event. Safe to call concurrently with itself for the same id only through the
 * job queue (same company lane). Returns the final status.
 */
export async function processRawEvent(rawEventId) {
    const raw = await orm().RawEvent.where({ id: rawEventId }).first();
    if (!raw || raw.status === "processed" || raw.status === "dead") return raw?.status ?? "missing";

    let connector = null;
    if (raw.connectorId) {
        connector = await orm().Connector.where({ id: raw.connectorId, workspaceId: raw.workspaceId }).first();
        if (!connector || connector.status === "disabled") {
            await orm().RawEvent.where({ id: raw.id }).update({ status: "failed", error: "Connector is disabled", nextAttemptAt: null });
            return "failed";
        }
    }

    const attempt = (raw.attempts ?? 0) + 1;
    await orm().RawEvent.where({ id: raw.id }).update({ attempts: attempt });
    try {
        await runProcessor(raw, connector);
        await orm().RawEvent.where({ id: raw.id }).update({ status: "processed", error: null, processedAt: new Date().toISOString(), nextAttemptAt: null });
        if (connector) markConnectorSuccess(connector);
        return "processed";
    } catch (err) {
        const dead = attempt >= MAX_ATTEMPTS || isPermanent(err);
        await orm()
            .RawEvent.where({ id: raw.id })
            .update({
                status: dead ? "dead" : "failed",
                error: String(err?.message ?? err).slice(0, 500),
                processedAt: new Date().toISOString(),
                nextAttemptAt: dead ? null : new Date(Date.now() + backoffMs(attempt)).toISOString(),
            });
        if (connector) {
            const wasHealthy = connector.status !== "failing";
            markConnectorFailure(connector, err?.message ?? String(err));
            if (wasHealthy) {
                dispatchWebhook(raw.workspaceId, "integration.failing", {
                    connectorId: connector.id,
                    connectorType: connector.type,
                    name: connector.name,
                    error: String(err?.message ?? err).slice(0, 300),
                });
            }
        }
        return dead ? "dead" : "failed";
    }
}

registerJobHandler("event.process", ({ rawEventId }) => processRawEvent(rawEventId));

/** Scheduler tick: queue every event that is due (pending ones left by a restart, failed ones whose backoff passed). */
export async function pollDueEvents(limit = 200) {
    const now = Date.now();
    const candidates = await orm()
        .RawEvent.where((e) => e.status.in(["pending", "failed"]))
        .orderBy((e) => e.receivedAt.asc())
        .limit(limit * 5)
        .all();
    let queued = 0;
    for (const e of candidates) {
        if (queued >= limit) break;
        const age = now - new Date(e.receivedAt).getTime();
        const due =
            // pending rows younger than a minute are still in the in-memory queue; older ones were lost by a restart
            (e.status === "pending" && age > STALE_PENDING_MS) ||
            // failed rows wait for their backoff; failed rows without nextAttemptAt are manual-replay only
            (e.status === "failed" && e.nextAttemptAt && new Date(e.nextAttemptAt).getTime() <= now);
        if (!due) continue;
        enqueueJob("event.process", { workspaceId: e.workspaceId, rawEventId: e.id });
        queued++;
    }
    return queued;
}

/** Queue depth and failures, for the platform health screen. */
export async function queueHealth() {
    const rows = await orm().RawEvent.where((e) => e.status.in(["pending", "failed", "dead", "replaying"])).all();
    const count = (s) => rows.filter((r) => r.status === s).length;
    return { pending: count("pending"), failed: count("failed"), dead: count("dead"), replaying: count("replaying") };
}
