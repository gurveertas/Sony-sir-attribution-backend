/**
 * Support sessions.
 *
 *   Platform admin  POST /api/platform-admin/support-sessions            start (reason required)
 *                   POST /api/platform-admin/support-sessions/:id/end    end early
 *                   GET  /api/platform-admin/support-sessions            own recent sessions
 *   Company admin   GET  /api/workspace/support-access                  who looked at our data, why, and when
 */

import { db } from "../src/prisma/db.js";
import { SUPPORT_HEADER, SupportAccessError, auditSupport, validateStartInput } from "../services/supportAccess.js";

const orm = () => db.orm.public;

const fail = (res, error) => {
    if (error instanceof SupportAccessError) return res.status(error.statusCode).json({ code: error.code, message: error.message });
    console.error("supportAccess error:", error.message);
    return res.status(500).json({ message: "Internal server error" });
};

const serialize = (s) => ({
    id: s.id,
    workspaceId: s.workspaceId,
    reason: s.reason,
    maskPii: s.maskPii,
    startedAt: s.startedAt,
    expiresAt: s.expiresAt,
    endedAt: s.endedAt ?? null,
});

export const startSupportSession = async (req, res) => {
    try {
        const input = validateStartInput(req.body ?? {});
        const workspace = await orm().Workspace.where({ id: input.workspaceId }).first();
        if (!workspace) throw new SupportAccessError(404, "not_found", "Workspace not found");

        const expiresAt = new Date(Date.now() + input.minutes * 60_000).toISOString();
        const session = await db.transaction(async (tx) => {
            const created = await tx.orm.public.SupportAccessSession.create({
                adminUserId: req.user.id,
                workspaceId: workspace.id,
                reason: input.reason,
                maskPii: input.maskPii,
                expiresAt,
            });
            await auditSupport(tx.orm.public, req, "support.session_started", created, {
                expiresAt,
                piiUnmasked: !input.maskPii,
            });
            return created;
        });

        return res.status(201).json({ ...serialize(session), usage: `Send "${SUPPORT_HEADER}: ${session.id}" with each /api/view/* request.` });
    } catch (error) {
        return fail(res, error);
    }
};

export const endSupportSession = async (req, res) => {
    try {
        const session = await orm().SupportAccessSession.where({ id: req.params.id }).first().catch(() => null);
        if (!session || session.adminUserId !== req.user.id) throw new SupportAccessError(404, "not_found", "Support session not found");
        if (session.endedAt) return res.status(200).json({ ...serialize(session), alreadyEnded: true });

        const endedAt = new Date().toISOString();
        await db.transaction(async (tx) => {
            await tx.orm.public.SupportAccessSession.where({ id: session.id }).update({ endedAt });
            await auditSupport(tx.orm.public, req, "support.session_ended", session);
        });
        return res.status(200).json({ ...serialize(session), endedAt });
    } catch (error) {
        return fail(res, error);
    }
};

export const listMySupportSessions = async (req, res) => {
    try {
        const rows = await orm()
            .SupportAccessSession.where({ adminUserId: req.user.id })
            .orderBy((s) => s.startedAt.desc())
            .limit(50)
            .all();
        return res.status(200).json({ data: rows.map(serialize) });
    } catch (error) {
        return fail(res, error);
    }
};

/** Company-facing transparency: every support session on this company's data. */
export const listSupportAccess = async (req, res) => {
    try {
        const rows = await orm()
            .SupportAccessSession.where({ workspaceId: req.user.workspaceId })
            .orderBy((s) => s.startedAt.desc())
            .limit(100)
            .all();
        const admins = new Map();
        for (const id of new Set(rows.map((r) => r.adminUserId))) {
            const admin = await orm().User.where({ id }).first();
            admins.set(id, admin?.name ?? "Platform support");
        }
        return res.status(200).json({
            data: rows.map((s) => ({ ...serialize(s), supportAgent: admins.get(s.adminUserId) })),
        });
    } catch (error) {
        return fail(res, error);
    }
};
