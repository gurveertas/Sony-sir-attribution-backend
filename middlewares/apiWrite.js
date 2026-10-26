/**
 * Middleware for public-API writes (scope 4.3 "Every write accepts an idempotency key", 4.12).
 *
 * idempotency()          `Idempotency-Key: <unique string>` — the first response is stored; a retry
 *                        with the same key and the same request gets the same response (header
 *                        `Idempotent-Replayed: true`); the same key with a different request is 422.
 * recordRawEvent(type)   stores the request as a RawEvent (D4) before processing, so every conversion
 *                        can be replayed. With `Prefer: respond-async` the request is acknowledged with
 *                        202 right after it is stored and processed in the background.
 */

import crypto from "crypto";
import { db } from "../src/prisma/db.js";
import { acceptEvent } from "../services/eventQueue.js";

const KEY_MAX = 200;
const hasModel = (name) => {
    try {
        return typeof db.orm.public[name]?.where === "function";
    } catch {
        return false;
    }
};

const requestHash = (req) =>
    crypto
        .createHash("sha256")
        .update(`${req.method} ${String(req.baseUrl ?? "")}${String(req.path ?? req.url ?? "").split("?")[0]} ${JSON.stringify(req.body ?? {})}`)
        .digest("hex");

const jsonSafe = (body) => JSON.parse(JSON.stringify(body ?? null, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

export function idempotency() {
    return async (req, res, next) => {
        const key = req.headers["idempotency-key"];
        if (!key || !req.workspaceId || !hasModel("IdempotencyKey")) return next();
        if (typeof key !== "string" || key.length > KEY_MAX) {
            return res.status(400).json({ message: `Idempotency-Key must be at most ${KEY_MAX} characters`, code: "validation_error" });
        }
        const orm = db.orm.public;
        const hash = requestHash(req);
        try {
            const stored = await orm.IdempotencyKey.where({ workspaceId: req.workspaceId, key }).first();
            if (stored) {
                if (stored.requestHash !== hash) {
                    return res.status(422).json({ message: "This Idempotency-Key was already used for a different request", code: "idempotency_key_reused" });
                }
                res.setHeader("Idempotent-Replayed", "true");
                return res.status(stored.statusCode).json(stored.responseBody);
            }
        } catch (err) {
            console.error("idempotency lookup failed:", err.message);
            return next();
        }

        const originalJson = res.json.bind(res);
        res.json = (body) => {
            if (res.statusCode < 500) {
                void orm.IdempotencyKey.create({
                    workspaceId: req.workspaceId,
                    key,
                    route: `${req.method} ${String(req.originalUrl ?? "").split("?")[0]}`.slice(0, 300),
                    requestHash: hash,
                    statusCode: res.statusCode,
                    responseBody: jsonSafe(body),
                }).catch(() => {}); // a concurrent duplicate lost the race: nothing to do
            }
            return originalJson(body);
        };
        return next();
    };
}

const wantsAsync = (req) => /respond-async/i.test(String(req.headers.prefer ?? "")) || req.query?.async === "true";

/**
 * @param {string} eventType  canonical event name (order.paid, booking.created, booking.updated, refund.created, order.updated)
 * @param {{withParamsId?: boolean}} opts  updates store { id, body } so a replay knows the target
 */
export function recordRawEvent(eventType, { withParamsId = false } = {}) {
    return async (req, res, next) => {
        if (!req.workspaceId) return next();
        const payload = withParamsId ? { id: req.params.id, body: req.body ?? {} } : req.body ?? {};
        const isTest = req.apiKey?.mode === "test";

        if (wantsAsync(req)) {
            try {
                const raw = await acceptEvent({ workspaceId: req.workspaceId, source: "api", eventType, payload, isTest, idempotencyKey: req.headers["idempotency-key"] ?? null });
                return res.status(202).json({ accepted: true, eventId: raw.id, status: "pending" });
            } catch (err) {
                console.error("async accept failed:", err.message);
                return res.status(503).json({ message: "Temporarily unable to accept events, please retry", code: "unavailable" });
            }
        }

        let raw = null;
        try {
            raw = await db.orm.public.RawEvent.create({
                workspaceId: req.workspaceId,
                connectorId: null,
                source: "api",
                eventType,
                payload,
                status: "pending",
                attempts: 1,
                isTest,
                idempotencyKey: req.headers["idempotency-key"] ?? null,
            });
        } catch (err) {
            // storing the copy must not block the write itself
            console.error("raw event store failed:", err.message);
            return next();
        }
        req.receivedAt = raw.receivedAt ?? new Date().toISOString();

        const originalJson = res.json.bind(res);
        res.json = (body) => {
            const ok = res.statusCode < 400;
            void db.orm.public.RawEvent.where({ id: raw.id })
                .update({
                    status: ok ? "processed" : "failed",
                    error: ok ? null : String(body?.message ?? `HTTP ${res.statusCode}`).slice(0, 500),
                    processedAt: new Date().toISOString(),
                    // server errors retry automatically; client errors wait for a manual replay
                    nextAttemptAt: !ok && res.statusCode >= 500 ? new Date(Date.now() + 30_000).toISOString() : null,
                })
                .catch(() => {});
            if (body && typeof body === "object" && !Array.isArray(body)) body = { ...body, eventId: raw.id };
            return originalJson(body);
        };
        return next();
    };
}
