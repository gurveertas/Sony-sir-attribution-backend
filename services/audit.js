/**
 * Audit logging that works with or without the AuditLog table.
 *
 * The AuditLog model is optional in this schema. When it exists, entries are written exactly as before
 * (and errors propagate, so a transaction behaves as it always did). When it does not exist, calling
 * `AuditLog.create` directly would throw a TypeError and abort whatever business operation (order
 * ingestion, API-key creation, ...) it was part of. `writeAudit` instead emits one structured JSON line
 * to the server log, so nothing breaks and nothing is silently lost.
 *
 * Set `{ required: true }` for operations that must not happen without a durable audit record:
 * the call then throws when the table is missing.
 *
 * Never put secrets or full request payloads in `entry.metadata`.
 */

export class AuditUnavailableError extends Error {
    constructor() {
        super("Audit log storage is not available");
        this.name = "AuditUnavailableError";
        this.statusCode = 503;
    }
}

export const hasAuditStore = (orm) => {
    try {
        return typeof orm?.AuditLog?.create === "function";
    } catch {
        return false;
    }
};

/** The AuditLog model for reading, or null when this schema has none. */
export const getAuditStore = (orm) => (hasAuditStore(orm) ? orm.AuditLog : null);

/**
 * @param {object} orm   db.orm.public or tx.orm.public
 * @param {object} entry { workspaceId, actorType, actorUserId, action, targetType, targetId, reason, metadata, ip, userAgent }
 */
export async function writeAudit(orm, entry, { required = false } = {}) {
    if (hasAuditStore(orm)) return orm.AuditLog.create(entry);
    if (required) throw new AuditUnavailableError();
    console.log(
        JSON.stringify({
            audit: true,
            at: new Date().toISOString(),
            workspaceId: entry.workspaceId ?? null,
            actorType: entry.actorType,
            actorUserId: entry.actorUserId ?? null,
            action: entry.action,
            targetType: entry.targetType ?? null,
            targetId: entry.targetId ?? null,
            reason: entry.reason ?? null,
            metadata: entry.metadata ?? null,
        }),
    );
    return null;
}

/** Remove a company's audit entries (only used when the whole company is deleted on request). */
export async function deleteAuditEntries(orm, workspaceId) {
    if (!hasAuditStore(orm) || !workspaceId) return 0;
    await orm.AuditLog.where({ workspaceId }).delete();
    return 1;
}
