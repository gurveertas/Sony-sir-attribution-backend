/**
 * Outbound Webhook Dispatcher
 *
 * Fires HTTP POST requests to customer-registered WebhookEndpoint URLs
 * when events occur (order.created, booking.created, refund.created, etc.).
 *
 * Features:
 *   - HMAC-SHA256 signature for payload integrity
 *   - Retry with exponential backoff (3 attempts)
 *   - Auto-disables endpoints after consecutive failures
 *   - Non-blocking: fires and forgets (does not block the main request)
 */

import crypto from "crypto";
import { db } from "../src/prisma/db.js";
import { decryptSecret } from "../utils/crypto.js";

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 5000, 15000]; // 1s, 5s, 15s
const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * Sign a JSON payload with HMAC-SHA256 using the endpoint's signing secret.
 */
function signPayload(payload, secretBuffer) {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const secret = decryptSecret(secretBuffer);
    return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Attempt to deliver a webhook to a single endpoint with retries.
 * Returns true if delivered successfully, false otherwise.
 */
async function deliverToEndpoint(endpoint, event) {
    const body = JSON.stringify(event);
    const signature = signPayload(body, endpoint.signingSecretEnc);
    const timestamp = Date.now().toString();

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

            const response = await fetch(endpoint.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Webhook-Signature": signature,
                    "X-Webhook-Timestamp": timestamp,
                    "X-Webhook-Event": event.type,
                    "User-Agent": "AttributionPlatform-Webhook/1.0",
                },
                body,
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (response.ok) {
                // Reset consecutive failures on success
                await db.orm.public.WebhookEndpoint.where({ id: endpoint.id }).update({
                    consecutiveFailures: 0,
                });
                return true;
            }

            // Non-retryable status codes
            if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                console.error(`Webhook ${endpoint.id} → ${endpoint.url}: HTTP ${response.status} (non-retryable)`);
                break;
            }
        } catch (err) {
            console.error(`Webhook ${endpoint.id} → ${endpoint.url}: attempt ${attempt + 1} failed:`, err.message);
        }

        // Wait before retry (except on last attempt)
        if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt] || 5000));
        }
    }

    // All retries exhausted — increment failure counter
    try {
        const current = await db.orm.public.WebhookEndpoint.where({ id: endpoint.id }).first();
        if (!current) return false;

        const newFailures = (current.consecutiveFailures || 0) + 1;
        const updates = { consecutiveFailures: newFailures };

        if (newFailures >= MAX_CONSECUTIVE_FAILURES) {
            updates.isActive = false;
            updates.disabledReason = `Auto-disabled after ${newFailures} consecutive delivery failures`;
            console.warn(`Webhook ${endpoint.id} auto-disabled after ${newFailures} failures`);
        }

        await db.orm.public.WebhookEndpoint.where({ id: endpoint.id }).update(updates);
    } catch (updateErr) {
        console.error("Failed to update webhook failure count:", updateErr.message);
    }

    return false;
}

/**
 * Dispatch an event to all matching active webhook endpoints for a workspace.
 * This runs fire-and-forget — it does not block the caller.
 *
 * @param {string} workspaceId - The workspace that owns the event
 * @param {string} eventType   - Event name (e.g. "order.created")
 * @param {object} data        - Event payload data
 */
export function dispatchWebhook(workspaceId, eventType, data) {
    // Fire-and-forget: don't await, don't block the main request
    void (async () => {
        try {
            const endpoints = await db.orm.public.WebhookEndpoint.where({
                workspaceId,
                isActive: true,
            }).all();

            // Filter endpoints that subscribe to this event type
            const matching = endpoints.filter(
                (ep) => ep.eventTypes && ep.eventTypes.includes(eventType)
            );

            if (matching.length === 0) return;

            const event = {
                id: crypto.randomUUID(),
                type: eventType,
                createdAt: new Date().toISOString(),
                workspaceId,
                data,
            };

            // Deliver to all matching endpoints concurrently
            await Promise.allSettled(
                matching.map((ep) => deliverToEndpoint(ep, event))
            );
        } catch (err) {
            console.error("dispatchWebhook top-level error:", err.message);
        }
    })();
}
