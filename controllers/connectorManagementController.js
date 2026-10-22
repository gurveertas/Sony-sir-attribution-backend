/**
 * Company-facing connector administration and event replay.
 * These handlers manage connector configuration and expose event status without leaking secrets or raw payloads by default.
 * Every lookup must remain scoped to the authenticated user's workspace.
 */

/**
 * Connector Management Controller  —  /api/workspace/connectors/*
 *
 * Company admins create and manage their inbound connectors
 * (Stripe, Shopify, Zenoti, Razorpay, PayPal, Generic) and operate their event feed.
 *
 * One-click gateway connection (Stripe / PayPal / Razorpay) lives in gatewayConnectController.js.
 */

import crypto from "crypto";
import { db } from "../src/prisma/db.js";
import { getConnectorConfig, prepareConnectorConfig } from "../utils/connectorConfig.js";
import { buildWebhookUrl, isGatewayType } from "../services/gateways/index.js";
import { isReplayable, processConnectorEvent } from "../services/connectorProcessors.js";
import { markConnectorSuccess, markRawEvent } from "../services/connectorRuntime.js";
import { summarizeConnector } from "./gatewayConnectController.js";
import { writeAudit } from "../services/audit.js";

const orm = () => db.orm.public;
const VALID_TYPES = ["zenoti", "stripe", "shopify", "razorpay", "generic", "woocommerce", "paypal", "square"];

/** After this many failed replays an event is parked as "dead" (needs force to retry). */
const MAX_REPLAYS = 5;
const BULK_REPLAY_MAX = 50;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Config keys owned by the gateway connect flow. Changing them through PATCH would break the link to the
// remote webhook, so they can only be changed through reconnect.
const GATEWAY_MANAGED_KEYS = [
    "gateway",
    "connectionMode",
    "webhookEndpointId",
    "webhookId",
    "webhookSecret",
    "clientId",
    "clientSecret",
    "fingerprint",
    "stripeAccountId",
];

/**
 * POST /api/workspace/connectors
 * Body: { type, name, config? }
 *
 * Manual creation (Shopify, Zenoti, Generic, ...). For Stripe / PayPal / Razorpay prefer
 * POST /api/workspace/connectors/connect, which also creates the webhook at the gateway.
 */
export const createConnector = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const { type, name, config = {} } = req.body ?? {};

        if (!type || !VALID_TYPES.includes(type)) {
            return res.status(400).json({ message: `type must be one of: ${VALID_TYPES.join(", ")}` });
        }
        if (!name || typeof name !== "string" || name.trim().length < 1) {
            return res.status(400).json({ message: "name is required" });
        }
        let storedConfig;
        try {
            storedConfig = prepareConnectorConfig(config);
        } catch (error) {
            return res.status(400).json({ message: error.message });
        }

        const publicId = `conn_${crypto.randomBytes(12).toString("hex")}`;

        const connector = await db.transaction(async (tx) => {
            const created = await tx.orm.public.Connector.create({
                workspaceId,
                type,
                name: name.trim(),
                publicId,
                status: "pending",
                ...storedConfig,
            });

            await writeAudit(tx.orm.public, {
                workspaceId,
                actorType: "user",
                actorUserId: req.user.id,
                action: "connector.created",
                targetType: "connector",
                targetId: created.id,
                metadata: { type, name: name.trim() },
                ip: req.ip ?? null,
                userAgent: req.headers["user-agent"] ?? null,
            });

            return created;
        });

        return res.status(201).json({
            id: connector.id,
            publicId: connector.publicId,
            type: connector.type,
            name: connector.name,
            status: connector.status,
            webhookUrl: buildWebhookUrl(type, connector.id),
            createdAt: connector.createdAt,
        });
    } catch (error) {
        console.error("createConnector:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /api/workspace/connectors
 */
export const listConnectors = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const connectors = await orm().Connector.where({ workspaceId }).all();
        return res.status(200).json({ data: connectors.map(summarizeConnector) });
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * PATCH /api/workspace/connectors/:id
 * Body: { name?, config?, status? }
 *
 * `config` is MERGED into the existing config (secrets included, they are re-encrypted);
 * send a key with value null to remove it.
 */
export const updateConnector = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const connector = await orm().Connector.where({ id: req.params.id, workspaceId }).first();
        if (!connector) return res.status(404).json({ message: "Connector not found" });

        const allowed = ["name", "config", "status"];
        const changes = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k)));

        if (changes.status && !["pending", "healthy", "disabled"].includes(changes.status)) {
            return res.status(400).json({ message: "Invalid status" });
        }

        const gatewayManaged = isGatewayType(connector.type) && connector.config?.gateway === connector.type;
        if (gatewayManaged && connector.status === "disabled" && changes.status && changes.status !== "disabled") {
            return res.status(409).json({ message: "This connector was disconnected. Use reconnect to enable it again." });
        }

        if (hasOwn(changes, "config")) {
            if (!changes.config || typeof changes.config !== "object" || Array.isArray(changes.config)) {
                return res.status(400).json({ message: "config must be an object" });
            }
            if (gatewayManaged) {
                const touched = GATEWAY_MANAGED_KEYS.filter((key) => hasOwn(changes.config, key));
                if (touched.length) {
                    return res.status(400).json({
                        message: `${touched.join(", ")} cannot be changed here. Use reconnect to change gateway credentials or the signing secret.`,
                    });
                }
            }
            try {
                const merged = { ...getConnectorConfig(connector), ...changes.config };
                for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
                Object.assign(changes, prepareConnectorConfig(merged));
            } catch (error) {
                return res.status(400).json({ message: error.message });
            }
        }

        if (!Object.keys(changes).length) return res.status(400).json({ message: "Nothing to update" });

        await orm().Connector.where({ id: connector.id }).update(changes);
        return res.status(200).json({ message: "Connector updated" });
    } catch (error) {
        console.error("updateConnector error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * DELETE /api/workspace/connectors/:id
 *
 * Removes a connector that never received data. Connectors with recorded events/orders/bookings are
 * referenced by them and must be disconnected instead (POST /connectors/:id/disconnect).
 */
export const deleteConnector = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const connector = await orm().Connector.where({ id: req.params.id, workspaceId }).first();
        if (!connector) return res.status(404).json({ message: "Connector not found" });

        try {
            await db.transaction(async (tx) => {
                await tx.orm.public.Connector.where({ id: connector.id }).delete();
                await writeAudit(tx.orm.public, {
                    workspaceId,
                    actorType: "user",
                    actorUserId: req.user.id,
                    action: "connector.deleted",
                    targetType: "connector",
                    targetId: connector.id,
                    metadata: { type: connector.type, name: connector.name },
                    ip: req.ip ?? null,
                    userAgent: req.headers["user-agent"] ?? null,
                });
            });
        } catch (error) {
            if (/foreign key|violates|constraint|still referenced/i.test(error.message)) {
                return res.status(409).json({
                    code: "connector_has_data",
                    message: "This connector has recorded events, orders or bookings and cannot be deleted. Disconnect it instead to stop it receiving data.",
                    disconnectUrl: `/api/workspace/connectors/${connector.id}/disconnect`,
                });
            }
            throw error;
        }

        return res.status(204).end();
    } catch (error) {
        console.error("deleteConnector error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /api/workspace/connectors/:id/events
 * Lists raw events for this connector (live feed / event log). Payloads are not included;
 * fetch a single event to see its payload.
 */
export const listConnectorEvents = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const connector = await orm().Connector.where({ id: req.params.id, workspaceId }).first();
        if (!connector) return res.status(404).json({ message: "Connector not found" });

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        const offset = (page - 1) * limit;

        let query = orm().RawEvent.where((e) => e.connectorId.eq(connector.id));
        if (req.query.status) {
            query = query.where((e) => e.status.eq(req.query.status));
        }

        const countResult = await query.aggregate((agg) => ({ total: agg.count() }));
        const total = countResult?.total || 0;

        const events = await query.orderBy((e) => e.receivedAt.desc()).limit(limit).offset(offset).all();

        const data = events.map((e) => ({
            id: e.id,
            source: e.source,
            eventType: e.eventType,
            status: e.status,
            error: e.error,
            replayCount: e.replayCount,
            receivedAt: e.receivedAt,
            processedAt: e.processedAt,
            hasPayload: !!e.payload,
        }));

        return res.status(200).json({
            data,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /api/workspace/connectors/:id/events/:eventId
 * One event including its raw payload (may contain customer PII — company_admin only).
 */
export const getConnectorEvent = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const connector = await orm().Connector.where({ id: req.params.id, workspaceId }).first();
        if (!connector) return res.status(404).json({ message: "Connector not found" });

        const event = await orm().RawEvent.where({ id: req.params.eventId, connectorId: connector.id }).first();
        if (!event) return res.status(404).json({ message: "Event not found" });

        return res.status(200).json({
            id: event.id,
            source: event.source,
            eventType: event.eventType,
            status: event.status,
            error: event.error,
            replayCount: event.replayCount,
            receivedAt: event.receivedAt,
            processedAt: event.processedAt,
            payload: event.payload,
        });
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

// ── Replay ───────────────────────────────────────────────────────────────────

const REPLAYABLE_STATUSES = ["failed", "pending"];
const FORCE_ONLY_STATUSES = ["dead", "replaying"];

/** Re-runs one stored event through the same processor the live webhook uses. Never throws. */
async function replayOne(connector, rawEvent) {
    const attempt = (rawEvent.replayCount || 0) + 1;
    await orm().RawEvent.where({ id: rawEvent.id }).update({ status: "replaying", replayCount: attempt });

    try {
        const result = await processConnectorEvent({
            connector,
            eventType: rawEvent.eventType,
            payload: rawEvent.payload,
        });
        await markRawEvent(rawEvent.id, "processed");
        markConnectorSuccess(connector);
        return { eventId: rawEvent.id, status: "processed", replayCount: attempt, result };
    } catch (err) {
        const status = attempt >= MAX_REPLAYS ? "dead" : "failed";
        await markRawEvent(rawEvent.id, status, err.message);
        return { eventId: rawEvent.id, status, replayCount: attempt, error: err.message };
    }
}

/**
 * POST /api/workspace/connectors/:id/events/:eventId/replay
 * Body: { force?: boolean }  — force is required to retry "dead" (or stuck "replaying") events.
 */
export const replayEvent = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const connector = await orm().Connector.where({ id: req.params.id, workspaceId }).first();
        if (!connector) return res.status(404).json({ message: "Connector not found" });
        if (connector.status === "disabled") {
            return res.status(409).json({ message: "Connector is disabled. Reconnect it before replaying events." });
        }
        if (!isReplayable(connector.type)) {
            return res.status(422).json({ message: `Replay is not supported for ${connector.type} connectors` });
        }

        const rawEvent = await orm().RawEvent.where({ id: req.params.eventId, connectorId: connector.id }).first();
        if (!rawEvent) return res.status(404).json({ message: "Event not found" });

        if (rawEvent.status === "processed") {
            return res.status(400).json({ message: "Event has already been processed successfully" });
        }
        const force = req.body?.force === true;
        if (FORCE_ONLY_STATUSES.includes(rawEvent.status) && !force) {
            return res.status(409).json({
                message: `Event is ${rawEvent.status}. Send force=true to retry it anyway.`,
                status: rawEvent.status,
            });
        }
        if (!REPLAYABLE_STATUSES.includes(rawEvent.status) && !FORCE_ONLY_STATUSES.includes(rawEvent.status)) {
            return res.status(409).json({ message: `Event in status "${rawEvent.status}" cannot be replayed` });
        }

        const outcome = await replayOne(connector, rawEvent);
        await writeAudit(orm(), {
            workspaceId,
            actorType: "user",
            actorUserId: req.user.id,
            action: "connector.event_replayed",
            targetType: "raw_event",
            targetId: rawEvent.id,
            metadata: { connectorId: connector.id, outcome: outcome.status },
            ip: req.ip ?? null,
            userAgent: req.headers["user-agent"] ?? null,
        });

        if (outcome.status === "processed") {
            return res.status(200).json({ message: "Event replayed successfully", ...outcome });
        }
        return res.status(422).json({ message: "Replay failed", ...outcome });
    } catch (error) {
        console.error("replayEvent error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * POST /api/workspace/connectors/:id/events/replay-failed
 * Body: { limit?: number (default 25, max 50) }
 * Takes the most recent failed events (up to `limit`) and replays them oldest-first, so an order is
 * processed before its refund.
 */
export const replayFailedEvents = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const connector = await orm().Connector.where({ id: req.params.id, workspaceId }).first();
        if (!connector) return res.status(404).json({ message: "Connector not found" });
        if (connector.status === "disabled") {
            return res.status(409).json({ message: "Connector is disabled. Reconnect it before replaying events." });
        }
        if (!isReplayable(connector.type)) {
            return res.status(422).json({ message: `Replay is not supported for ${connector.type} connectors` });
        }

        const limit = Math.min(BULK_REPLAY_MAX, Math.max(1, parseInt(req.body?.limit) || 25));
        const failed = await orm()
            .RawEvent.where((e) => e.connectorId.eq(connector.id))
            .where((e) => e.status.eq("failed"))
            .orderBy((e) => e.receivedAt.desc())
            .limit(limit)
            .all();
        failed.reverse(); // chronological order

        const results = [];
        for (const rawEvent of failed) {
            const outcome = await replayOne(connector, rawEvent);
            results.push({ eventId: outcome.eventId, status: outcome.status, error: outcome.error ?? null });
        }

        await writeAudit(orm(), {
            workspaceId,
            actorType: "user",
            actorUserId: req.user.id,
            action: "connector.bulk_replay",
            targetType: "connector",
            targetId: connector.id,
            metadata: { attempted: results.length, processed: results.filter((r) => r.status === "processed").length },
            ip: req.ip ?? null,
            userAgent: req.headers["user-agent"] ?? null,
        });

        return res.status(200).json({
            attempted: results.length,
            processed: results.filter((r) => r.status === "processed").length,
            stillFailing: results.filter((r) => r.status === "failed").length,
            dead: results.filter((r) => r.status === "dead").length,
            results,
        });
    } catch (error) {
        console.error("replayFailedEvents error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};
