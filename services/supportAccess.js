import { writeAudit } from "./audit.js";
/**
 * Platform-admin support access.
 *
 * A platform admin may look at a company's data only inside a SUPPORT SESSION:
 *   - a written reason is required,
 *   - the session is short-lived and can be ended early,
 *   - personal data is masked unless the session explicitly unmasks it,
 *   - starting/ending the session and EVERY data request are written to the audit log with the
 *     company's workspaceId, so the company can see them in its own audit log.
 */

export const REASON_MIN = 10;
export const REASON_MAX = 500;
export const DEFAULT_MINUTES = 30;
export const MAX_MINUTES = 120;
export const SUPPORT_HEADER = "x-support-session";

/** Set SUPPORT_ACCESS_REQUIRED=false only as a temporary migration aid while the admin UI is updated. */
export const supportAccessRequired = () => String(process.env.SUPPORT_ACCESS_REQUIRED ?? "true").toLowerCase() !== "false";

export class SupportAccessError extends Error {
    constructor(status, code, message) {
        super(message);
        this.statusCode = status;
        this.code = code;
    }
}

export function validateStartInput({ workspaceId, reason, durationMinutes, maskPii }) {
    if (typeof workspaceId !== "string" || !workspaceId.trim() || workspaceId.length > 200) {
        throw new SupportAccessError(400, "validation_error", "workspaceId is required");
    }
    const cleanReason = typeof reason === "string" ? reason.trim() : "";
    if (cleanReason.length < REASON_MIN) {
        throw new SupportAccessError(400, "reason_required", `Provide a reason of at least ${REASON_MIN} characters (it is shown to the company).`);
    }
    if (cleanReason.length > REASON_MAX) {
        throw new SupportAccessError(400, "validation_error", `reason must be at most ${REASON_MAX} characters`);
    }
    const minutes = durationMinutes === undefined ? DEFAULT_MINUTES : Number(durationMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
        throw new SupportAccessError(400, "validation_error", `durationMinutes must be a whole number between 1 and ${MAX_MINUTES}`);
    }
    if (maskPii !== undefined && typeof maskPii !== "boolean") {
        throw new SupportAccessError(400, "validation_error", "maskPii must be true or false");
    }
    return { workspaceId: workspaceId.trim(), reason: cleanReason, minutes, maskPii: maskPii ?? true };
}

/**
 * Finds the session sent with the request and checks it belongs to this admin and workspace,
 * has not ended and has not expired.
 */
export async function loadActiveSession(orm, req, workspaceId, now = new Date()) {
    const sessionId = String(req.headers?.[SUPPORT_HEADER] ?? "").trim();
    if (!sessionId) {
        throw new SupportAccessError(403, "support_session_required", `A support session is required. Start one with POST /api/platform-admin/support-sessions and send its id in the ${SUPPORT_HEADER} header.`);
    }
    let session = null;
    try {
        session = await orm.SupportAccessSession.where({ id: sessionId }).first();
    } catch {
        session = null; // malformed id
    }
    if (!session || session.adminUserId !== req.user.id || session.workspaceId !== workspaceId) {
        throw new SupportAccessError(403, "support_session_invalid", "This support session is not valid for this workspace.");
    }
    if (session.endedAt) throw new SupportAccessError(403, "support_session_ended", "This support session has ended.");
    if (new Date(session.expiresAt) <= now) throw new SupportAccessError(403, "support_session_expired", "This support session has expired. Start a new one.");
    return session;
}

export function auditSupport(orm, req, action, session, extra = {}) {
    return writeAudit(orm, {
        workspaceId: session.workspaceId,
        actorType: "platform_admin",
        actorUserId: req.user.id,
        action,
        targetType: "workspace",
        targetId: session.workspaceId,
        reason: session.reason,
        metadata: { sessionId: session.id, maskPii: session.maskPii, ...extra },
        ip: req.ip ?? null,
        userAgent: req.headers?.["user-agent"] ?? null,
    });
}
