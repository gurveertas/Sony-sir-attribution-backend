/**
 * Shared runtime helpers for connector webhooks and replay:
 * raw-event persistence and connector health bookkeeping.
 */

import { db } from "../src/prisma/db.js";

const orm = () => db.orm.public;

export async function lookupConnector(connectorId, workspaceId) {
    try {
        const connector = await orm().Connector.where({ id: connectorId }).first();
        if (!connector) return null;
        if (workspaceId && connector.workspaceId !== workspaceId) return null;
        return connector;
    } catch {
        // malformed id (e.g. not a UUID) is simply "not found"
        return null;
    }
}

export async function lookupWorkspace(workspaceId) {
    try {
        return await orm().Workspace.where({ id: workspaceId }).first();
    } catch {
        return null;
    }
}

export async function saveRawEvent(workspaceId, connectorId, source, eventType, payload) {
    try {
        return await orm().RawEvent.create({
            workspaceId,
            connectorId,
            source,
            eventType,
            payload,
            status: "pending",
        });
    } catch (err) {
        console.error("saveRawEvent error:", err.message);
        return null;
    }
}

export async function markRawEvent(rawEventId, status, error = null) {
    if (!rawEventId) return;
    try {
        await orm().RawEvent.where({ id: rawEventId }).update({
            status,
            error: error ? String(error).slice(0, 500) : null,
            processedAt: new Date().toISOString(),
        });
    } catch {
        /* non-critical */
    }
}

export function touchLastEvent(connectorId) {
    void orm()
        .Connector.where({ id: connectorId })
        .update({ lastEventAt: new Date().toISOString() })
        .catch(() => {});
}

/** A processed event proves the connector works: pending/failing -> healthy. */
export function markConnectorSuccess(connector) {
    if (connector.status === "healthy" || connector.status === "disabled") return;
    void orm()
        .Connector.where({ id: connector.id })
        .update({ status: "healthy" })
        .catch(() => {});
}

export function markConnectorFailure(connector, message) {
    void orm()
        .Connector.where({ id: connector.id })
        .update({
            errorCount: (connector.errorCount || 0) + 1,
            lastError: String(message).slice(0, 500),
            lastErrorAt: new Date().toISOString(),
            status: "failing",
        })
        .catch(() => {});
}
