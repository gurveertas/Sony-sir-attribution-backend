/**
 * Workspace Settings Controller  —  /api/workspace/*
 *
 * Company admins manage their workspace settings, team invites,
 * locations, channel mapping rules, outbound webhooks, and audit log.
 *
 * All routes protected by protectRoute + requireRole("company_admin") or "company_viewer".
 */

import { db } from "../src/prisma/db.js";
import crypto from "crypto";
import { sendEmail } from "../services/emailServices.js";
import bcrypt from "bcryptjs";
import { encryptSecret } from "../utils/crypto.js";
import { getAuditStore, writeAudit } from "../services/audit.js";
import { validateWorkspaceSettings, scheduleRebuildIfNeeded } from "../services/workspaceSettings.js";
import { invalidateTrackingCache } from "./trackingController.js";
import { purgeWorkspace } from "../services/privacy.js";
import { enqueueJob } from "../services/jobs.js";
import { passwordProblem } from "../utils/passwordPolicy.js";
import { isValidTimeZone } from "../utils/timezone.js";
import { WEBHOOK_EVENT_TYPES } from "../services/webhookDispatcher.js";
import { sendCsv, wantsCsv, paginate, sortDesc } from "../services/http.js";
import ENV from "../utils/env.js";
import { requestRebuild } from "../services/rollups.js";
import { frontendBase } from "../utils/frontendUrl.js";

const orm = () => db.orm.public;

// ────────────────────────────────────────
// Settings
// ────────────────────────────────────────

/**
 * GET /api/workspace/settings
 */
export const getWorkspaceSettings = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const workspace = await orm().Workspace.where({ id: workspaceId }).first();
        if (!workspace) return res.status(404).json({ message: "Workspace not found" });

        const { emailVerificationHash, ...safe } = workspace;
        return res.status(200).json({ data: safe });
    } catch (error) {
        console.error("getWorkspaceSettings:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// DELETE /api/workspace/:workspaceId
export const deleteWorkspace = async (req, res) => {
    try {
        const reason = String(req.body?.reason ?? req.query?.reason ?? "").trim();
        if (req.user.role === "platform_admin") {
            // platform admins delete a company's data through the audited purge tool
            if (reason.length < 5) return res.status(400).json({ message: "Provide a reason of at least 5 characters.", code: "reason_required" });
            const out = await purgeWorkspace(req.params.workspaceId, { keepAccount: false, actorUserId: req.user.id, reason, ip: req.ip, userAgent: req.headers?.["user-agent"] });
            if (!out) return res.status(404).json({ message: "Workspace not found", code: "not_found" });
            return res.status(200).json({ message: "Workspace deleted successfully", ...out });
        }
        if (req.user.role !== "company_admin") return res.status(403).json({ message: "Only company admins can close the company account", code: "forbidden" });
        if (req.params.workspaceId !== req.user.workspaceId) return res.status(404).json({ message: "Workspace not found", code: "not_found" });
        const workspace = await orm().Workspace.where({ id: req.user.workspaceId }).first();
        if (req.body?.confirm !== workspace?.slug) {
            return res.status(400).json({ message: `Type your company slug (${workspace?.slug}) in "confirm" to close the account.`, code: "confirmation_required" });
        }
        // Closing stops all access and tracking immediately; the data is deleted by the platform team on request.
        await orm().Workspace.where({ id: workspace.id }).update({ status: "closed", suspendedReason: reason || "Closed by the company", deletedAt: new Date().toISOString() });
        await writeAudit(orm(), { workspaceId: workspace.id, actorType: "user", actorUserId: req.user.id, action: "workspace.closed", targetType: "workspace", targetId: workspace.id, reason: reason || null, ip: req.ip ?? null, userAgent: req.headers?.["user-agent"] ?? null });
        return res.status(200).json({ message: "Company account closed" });
    } catch (error) {
        console.error("deleteWorkspace:", error.message);
        return res.status(500).json({ message: "Internal server error in delete workspace", code: "internal_error" });
    }
};

/**
 * PATCH /api/workspace/settings
 */
export const updateWorkspaceSettings = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const workspace = await orm().Workspace.where({ id: workspaceId }).first();
        if (!workspace) return res.status(404).json({ message: "Workspace not found" });

        const changes = Object.fromEntries(
            Object.entries(req.body ?? {}).filter(([k]) => ALLOWED_SETTINGS.has(k))
        );
        if (!Object.keys(changes).length) return res.status(400).json({ message: "No valid settings provided" });

        const problem = validateWorkspaceSettings(changes);
        if (problem) return res.status(400).json({ message: problem, code: "validation_error" });

        await db.transaction(async (tx) => {
            await tx.orm.public.Workspace.where({ id: workspaceId }).update(changes);
            await writeAudit(tx.orm.public, {
                workspaceId,
                actorType: "user",
                actorUserId: req.user.id,
                action: "workspace.settings_updated",
                targetType: "workspace",
                targetId: workspaceId,
                metadata: { changedFields: Object.keys(changes) },
                ip: req.ip ?? null,
                userAgent: req.headers["user-agent"] ?? null,
            });
        });

        invalidateTrackingCache(workspaceId);
        const queued = await scheduleRebuildIfNeeded(workspaceId, Object.keys(changes), req.user.id);

        const updated = await orm().Workspace.where({ id: workspaceId }).first();
        const { emailVerificationHash, ...safe } = updated;
        return res.status(200).json({
            message: queued ? "Settings updated. Reports are being recalculated with the new settings." : "Settings updated",
            recalculating: queued,
            data: safe,
        });
    } catch (error) {
        console.error("updateWorkspaceSettings:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// ────────────────────────────────────────
// Team / Invites
// ────────────────────────────────────────

/**
 * POST /api/workspace/invites
 * Body: { email, role, allowedLocationIds? }
 */
export const inviteUser = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const { email, role, allowedLocationIds = [] } = req.body ?? {};

        if (!email || !String(email).includes("@")) return res.status(400).json({ message: "a valid email is required" });
        if (!Array.isArray(allowedLocationIds)) return res.status(400).json({ message: "allowedLocationIds must be a list" });
        if (allowedLocationIds.length) {
            const own = new Set((await orm().Location.where({ workspaceId }).all()).map((l) => l.id));
            if (allowedLocationIds.some((id) => !own.has(id))) return res.status(400).json({ message: "allowedLocationIds contains a location of another company" });
        }
        if (!["company_admin", "company_viewer"].includes(role)) {
            return res.status(400).json({ message: "role must be company_admin or company_viewer" });
        }

        const normalizedEmail = email.trim().toLowerCase();

        // Check if already a user
        const existingUser = await orm().User.where({ email: normalizedEmail }).first();
        if (existingUser) {
            return res.status(409).json({ message: existingUser.workspaceId === workspaceId ? "This user is already a member of your workspace" : "This email already has an account" });
        }

        // Check for an open invite (any of them: older ones may be revoked or expired)
        const open = (await orm().Invite.where({ workspaceId, email: normalizedEmail }).all()).find((i) => inviteStatus(i) === "pending");
        if (open) {
            return res.status(409).json({ message: "A pending invite already exists for this email. Resend it from the Team page.", code: "invite_exists", inviteId: open.id });
        }

        const rawToken = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
        const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

        await db.transaction(async (tx) => {
            await tx.orm.public.Invite.create({
                workspaceId,
                email: normalizedEmail,
                role,
                allowedLocationIds: Array.isArray(allowedLocationIds) ? allowedLocationIds : [],
                invitedBy: req.user.id,
                tokenHash,
                expiresAt,
            });

            await writeAudit(tx.orm.public, {
                workspaceId,
                actorType: "user",
                actorUserId: req.user.id,
                action: "invite.sent",
                targetType: "invite",
                targetId: null,
                metadata: { email: normalizedEmail, role },
                ip: req.ip ?? null,
                userAgent: req.headers["user-agent"] ?? null,
            });
        });

        // Send invite email (a failure does not undo the invite: it can be resent)
        const emailed = await sendInviteEmail(req, normalizedEmail, role, rawToken);

        return res.status(201).json({ message: emailed ? "Invite sent" : "Invite created, but the email could not be sent. Use Resend.", email: normalizedEmail, emailed });
    } catch (error) {
        console.error("inviteUser:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** pending | expired | accepted | revoked */
export function inviteStatus(invite, now = new Date()) {
    if (invite.acceptedAt) return "accepted";
    if (invite.revokedAt) return "revoked";
    return new Date(invite.expiresAt) > now ? "pending" : "expired";
}

async function sendInviteEmail(req, email, role, rawToken) {
    try {
        await sendEmail({
            to: email,
            subject: "You've been invited to join a workspace",
            html: `<p>You have been invited to join the analytics dashboard as <strong>${role === "company_admin" ? "an admin" : "a viewer"}</strong>.</p>
                   <p>Accept your invite: <a href="${frontendBase(req)}/accept-invite?token=${rawToken}">Click here</a></p>
                   <p>This link expires in 7 days.</p>`,
        });
        return true;
    } catch (emailErr) {
        console.error("Failed to send invite email:", emailErr.message);
        return false;
    }
}

const publicInvite = (i, inviters = new Map()) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    allowedLocationIds: i.allowedLocationIds ?? [],
    status: inviteStatus(i),
    invitedBy: i.invitedBy,
    invitedByName: inviters.get(i.invitedBy) ?? null,
    expiresAt: i.expiresAt,
    acceptedAt: i.acceptedAt ?? null,
    revokedAt: i.revokedAt ?? null,
    createdAt: i.createdAt,
});

async function loadOwnInvite(req, res) {
    const invite = await orm().Invite.where({ id: req.params.id, workspaceId: req.user.workspaceId }).first();
    if (!invite) {
        res.status(404).json({ message: "Invite not found", code: "not_found" });
        return null;
    }
    return invite;
}

const inviteAudit = (req, action, invite, metadata = {}) =>
    writeAudit(orm(), {
        workspaceId: req.user.workspaceId,
        actorType: "user",
        actorUserId: req.user.id,
        action,
        targetType: "invite",
        targetId: invite.id,
        metadata: { email: invite.email, ...metadata },
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
    });

/**
 * GET /api/workspace/invites?status=open|pending|expired|accepted|revoked|all (default: open = pending + expired)
 */
export const listInvites = async (req, res) => {
    try {
        const wanted = String(req.query.status ?? "open");
        const rows = await orm().Invite.where({ workspaceId: req.user.workspaceId }).all();
        const inviters = new Map((await orm().User.where({ workspaceId: req.user.workspaceId }).all()).map((u) => [u.id, u.name]));
        const data = rows
            .filter((i) => {
                const st = inviteStatus(i);
                if (wanted === "all") return true;
                if (wanted === "open") return st === "pending" || st === "expired";
                return st === wanted;
            })
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
            .map((i) => publicInvite(i, inviters));
        return res.status(200).json({ data });
    } catch (error) {
        console.error("listInvites:", error.message);
        return res.status(500).json({ message: "Internal server error", code: "internal_error" });
    }
};

/** PATCH /api/workspace/invites/:id { role?, allowedLocationIds? } — only while not accepted or revoked. */
export const updateInvite = async (req, res) => {
    try {
        const invite = await loadOwnInvite(req, res);
        if (!invite) return;
        if (["accepted", "revoked"].includes(inviteStatus(invite))) return res.status(409).json({ message: `This invite was already ${inviteStatus(invite)}`, code: "conflict" });
        const changes = {};
        if (req.body?.role !== undefined) {
            if (!["company_admin", "company_viewer"].includes(req.body.role)) return res.status(400).json({ message: "role must be company_admin or company_viewer", code: "validation_error" });
            changes.role = req.body.role;
        }
        if (req.body?.allowedLocationIds !== undefined) {
            const ids = req.body.allowedLocationIds;
            if (!Array.isArray(ids)) return res.status(400).json({ message: "allowedLocationIds must be a list (empty = all locations)", code: "validation_error" });
            const own = new Set((await orm().Location.where({ workspaceId: req.user.workspaceId }).all()).map((l) => l.id));
            if (ids.some((id) => !own.has(id))) return res.status(400).json({ message: "allowedLocationIds contains an unknown location", code: "validation_error" });
            changes.allowedLocationIds = ids;
        }
        if ((changes.role ?? invite.role) === "company_admin") changes.allowedLocationIds = []; // admins see every location
        if (!Object.keys(changes).length) return res.status(400).json({ message: "Nothing to update", code: "validation_error" });
        await orm().Invite.where({ id: invite.id }).update(changes);
        await inviteAudit(req, "invite.updated", invite, { changedFields: Object.keys(changes) });
        return res.status(200).json({ message: "Invite updated", data: publicInvite({ ...invite, ...changes }) });
    } catch (error) {
        console.error("updateInvite:", error.message);
        return res.status(500).json({ message: "Internal server error", code: "internal_error" });
    }
};

/** POST /api/workspace/invites/:id/resend — new link (the old one stops working), valid 7 more days. */
export const resendInvite = async (req, res) => {
    try {
        const invite = await loadOwnInvite(req, res);
        if (!invite) return;
        if (["accepted", "revoked"].includes(inviteStatus(invite))) return res.status(409).json({ message: `This invite was already ${inviteStatus(invite)}`, code: "conflict" });
        if (await orm().User.where({ email: invite.email }).first()) return res.status(409).json({ message: "This email already has an account", code: "conflict" });
        const rawToken = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
        const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
        await orm().Invite.where({ id: invite.id }).update({ tokenHash, expiresAt });
        const emailed = await sendInviteEmail(req, invite.email, invite.role, rawToken);
        await inviteAudit(req, "invite.resent", invite, { emailed });
        if (!emailed) return res.status(502).json({ message: "The invite was renewed, but the email could not be sent. Try again later.", code: "email_failed" });
        return res.status(200).json({ message: `Invite sent again to ${invite.email}`, data: publicInvite({ ...invite, expiresAt }) });
    } catch (error) {
        console.error("resendInvite:", error.message);
        return res.status(500).json({ message: "Internal server error", code: "internal_error" });
    }
};

/** DELETE /api/workspace/invites/:id — revoke: the link stops working; the row stays for the audit trail. */
export const revokeInvite = async (req, res) => {
    try {
        const invite = await loadOwnInvite(req, res);
        if (!invite) return;
        const st = inviteStatus(invite);
        if (st === "accepted") return res.status(409).json({ message: "This invite was already accepted. Remove the user from the team instead.", code: "conflict" });
        if (st !== "revoked") {
            await orm().Invite.where({ id: invite.id }).update({ revokedAt: new Date().toISOString() });
            await inviteAudit(req, "invite.revoked", invite);
        }
        return res.status(200).json({ message: "Invite deleted" });
    } catch (error) {
        console.error("revokeInvite:", error.message);
        return res.status(500).json({ message: "Internal server error", code: "internal_error" });
    }
};

/**
 * POST /api/workspace/invites/accept
 * Body: { token, password, name }
 */
export const acceptInvite = async (req, res) => {
    try {
        const { token, password, name } = req.body ?? {};
        if (!token) return res.status(400).json({ message: "token is required" });

        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const invite = await orm().Invite.where({ tokenHash }).first();

        if (!invite || invite.revokedAt || invite.acceptedAt) {
            return res.status(400).json({ message: "Invalid or already used invite link" });
        }
        if (new Date(invite.expiresAt) < new Date()) {
            return res.status(400).json({ message: "Invite link has expired" });
        }
        const pwProblem = passwordProblem(password, invite.email);
        if (pwProblem) return res.status(400).json({ message: pwProblem, code: "weak_password" });

        const passwordHash = await bcrypt.hash(password, 10);

        await db.transaction(async (tx) => {
            const user = await tx.orm.public.User.create({
                workspaceId: invite.workspaceId,
                email: invite.email,
                name: name || invite.email,
                passwordHash,
                role: invite.role,
                status: "active",
                emailVerifiedAt: new Date().toISOString(),
                passwordChangedAt: new Date().toISOString(),
            });

            // Create location access if specified
            for (const locationId of (invite.allowedLocationIds || [])) {
                await tx.orm.public.UserLocationAccess.create({
                    userId: user.id,
                    locationId,
                    workspaceId: invite.workspaceId,
                });
            }

            await tx.orm.public.Invite.where({ id: invite.id }).update({
                acceptedAt: new Date().toISOString(),
            });

            await writeAudit(tx.orm.public, {
                workspaceId: invite.workspaceId,
                actorType: "user",
                actorUserId: user.id,
                action: "invite.accepted",
                targetType: "user",
                targetId: user.id,
                metadata: { email: invite.email, role: invite.role },
                ip: req.ip ?? null,
                userAgent: req.headers["user-agent"] ?? null,
            });
        });

        return res.status(200).json({ message: "Invite accepted. You can now log in." });
    } catch (error) {
        if (error?.code === "23505") return res.status(409).json({ message: "Email is already registered" });
        console.error("acceptInvite:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /api/workspace/team — list workspace users
 */
export const listTeam = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const [users, access, invites] = await Promise.all([
            orm().User.where({ workspaceId }).all(),
            orm().UserLocationAccess.where({ workspaceId }).all(),
            req.user.role === "company_admin" ? orm().Invite.where({ workspaceId }).all() : [],
        ]);
        return res.status(200).json({
            data: users.map(({ passwordHash, twoFactorSecretEnc, failedLoginCount, lockedUntil, ...u }) => ({
                ...u,
                allowedLocationIds: access.filter((a) => a.userId === u.id).map((a) => a.locationId),
            })),
            // open invites (pending or expired), so they can be resent or deleted from the Team page
            pendingInvites: invites
                .filter((i) => ["pending", "expired"].includes(inviteStatus(i)))
                .map((i) => publicInvite(i)),
        });
    } catch (error) {
        console.error("listTeam:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * PATCH /api/workspace/team/:userId — update a team member (role, status)
 */
export const updateTeamMember = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const user = await orm().User.where({ id: req.params.userId, workspaceId }).first();
        if (!user) return res.status(404).json({ message: "User not found" });
        if (user.id === req.user.id) return res.status(400).json({ message: "Cannot modify your own account here" });

        const allowed = ["role", "status"];
        const changes = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k)));
        if (changes.role && !["company_admin", "company_viewer"].includes(changes.role)) return res.status(400).json({ message: "Invalid role" });
        if (changes.status && !["active", "deactivated"].includes(changes.status)) return res.status(400).json({ message: "Invalid status" });

        const locationIds = req.body?.allowedLocationIds;
        if (locationIds !== undefined) {
            if (!Array.isArray(locationIds)) return res.status(400).json({ message: "allowedLocationIds must be a list (empty = all locations)" });
            const own = new Set((await orm().Location.where({ workspaceId }).all()).map((l) => l.id));
            if (locationIds.some((id) => !own.has(id))) return res.status(400).json({ message: "allowedLocationIds contains an unknown location" });
        }
        if (!Object.keys(changes).length && locationIds === undefined) return res.status(400).json({ message: "Nothing to update" });

        if (user.role === "company_admin" && ((changes.role && changes.role !== "company_admin") || changes.status === "deactivated")) {
            const admins = (await orm().User.where({ workspaceId, role: "company_admin" }).all()).filter((u) => u.status === "active");
            if (admins.length <= 1) return res.status(409).json({ message: "A company must keep at least one active admin", code: "last_admin" });
        }

        await db.transaction(async (tx) => {
            if (Object.keys(changes).length) await tx.orm.public.User.where({ id: user.id }).update(changes);
            if (locationIds !== undefined) {
                await tx.orm.public.UserLocationAccess.where({ userId: user.id }).delete();
                for (const locationId of [...new Set(locationIds)]) await tx.orm.public.UserLocationAccess.create({ userId: user.id, locationId, workspaceId });
            }
            await writeAudit(tx.orm.public, {
                workspaceId,
                actorType: "user",
                actorUserId: req.user.id,
                action: "team.member_updated",
                targetType: "user",
                targetId: user.id,
                metadata: { changedFields: [...Object.keys(changes), ...(locationIds !== undefined ? ["allowedLocationIds"] : [])] },
                ip: req.ip ?? null,
                userAgent: req.headers["user-agent"] ?? null,
            });
        });

        return res.status(200).json({ message: "Team member updated" });
    } catch (error) {
        console.error("updateTeamMember:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// ────────────────────────────────────────
// Locations
// ────────────────────────────────────────

export const listLocations = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const locations = await orm().Location.where({ workspaceId }).all();
        return res.status(200).json({ data: locations });
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const createLocation = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const { name, timezone, currency, externalIds } = req.body ?? {};
        const workspace = await orm().Workspace.where({ id: workspaceId }).first();
        if (!name || !String(name).trim()) return res.status(400).json({ message: "name is required" });
        const tz = timezone || workspace?.timezone || "UTC";
        if (!isValidTimeZone(tz)) return res.status(400).json({ message: "timezone must be an IANA name such as Asia/Dubai" });
        const cur = String(currency || workspace?.reportingCurrency || "USD").toUpperCase();
        if (!/^[A-Z]{3}$/.test(cur)) return res.status(400).json({ message: "currency must be a 3-letter ISO code" });
        if (externalIds !== undefined && externalIds !== null && (typeof externalIds !== "object" || Array.isArray(externalIds))) {
            return res.status(400).json({ message: 'externalIds must be an object, e.g. { "zenoti": "<center id>" }' });
        }

        const location = await orm().Location.create({ workspaceId, name: String(name).trim(), timezone: tz, currency: cur, externalIds: externalIds ?? null });
        await writeAudit(orm(), { workspaceId, actorType: "user", actorUserId: req.user.id, action: "location.created", targetType: "location", targetId: location.id, ip: req.ip ?? null, userAgent: req.headers["user-agent"] ?? null });
        return res.status(201).json({ data: location });
    } catch (error) {
        console.error("createLocation:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const updateLocation = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const location = await orm().Location.where({ id: req.params.id, workspaceId }).first();
        if (!location) return res.status(404).json({ message: "Location not found" });

        const allowed = ["name", "timezone", "currency", "externalIds", "isActive"];
        const changes = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k)));
        if (!Object.keys(changes).length) return res.status(400).json({ message: "Nothing to update" });
        if ("timezone" in changes && !isValidTimeZone(changes.timezone)) return res.status(400).json({ message: "timezone must be an IANA name" });
        if ("currency" in changes) {
            changes.currency = String(changes.currency).toUpperCase();
            if (!/^[A-Z]{3}$/.test(changes.currency)) return res.status(400).json({ message: "currency must be a 3-letter ISO code" });
        }
        if ("isActive" in changes && typeof changes.isActive !== "boolean") return res.status(400).json({ message: "isActive must be true or false" });

        await orm().Location.where({ id: location.id }).update(changes);
        await writeAudit(orm(), { workspaceId, actorType: "user", actorUserId: req.user.id, action: "location.updated", targetType: "location", targetId: location.id, metadata: { changedFields: Object.keys(changes) }, ip: req.ip ?? null, userAgent: req.headers["user-agent"] ?? null });
        // a location's timezone sets its day boundaries
        if ("timezone" in changes && changes.timezone !== location.timezone) await requestRebuild(workspaceId, "location_timezone_changed");
        return res.status(200).json({ message: "Location updated" });
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const deleteLocation = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const location = await orm().Location.where({ id: req.params.id, workspaceId }).first();
        if (!location) return res.status(404).json({ message: "Location not found" });
        const used = (await orm().Order.where({ workspaceId, locationId: location.id }).first()) || (await orm().Booking.where({ workspaceId, locationId: location.id }).first());
        if (used) return res.status(409).json({ message: "This location has orders or bookings. Deactivate it instead (isActive: false).", code: "location_has_data" });
        await orm().UserLocationAccess.where({ locationId: location.id }).delete();
        await orm().Location.where({ id: location.id }).delete();
        await writeAudit(orm(), { workspaceId, actorType: "user", actorUserId: req.user.id, action: "location.deleted", targetType: "location", targetId: location.id, ip: req.ip ?? null, userAgent: req.headers["user-agent"] ?? null });
        return res.status(204).end();
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

// ────────────────────────────────────────
// Channel Mapping Rules
// ────────────────────────────────────────

const RULE_FIELDS = new Set(["source", "medium", "campaign", "term", "content", "referrer", "referrerHost", "landingPage", "gclid", "fbclid", "ttclid", "msclkid"]);

function validateRule({ priority, match, channel }, partial = false) {
    if (!partial || priority !== undefined) {
        if (!Number.isInteger(priority) || priority < 0 || priority > 10000) return "priority must be a whole number from 0 to 10000";
    }
    if (!partial || match !== undefined) {
        if (!match || typeof match !== "object" || Array.isArray(match) || !Object.keys(match).length) return "match must be an object such as { \"source\": \"newsletter\" }";
        for (const [field, value] of Object.entries(match)) {
            if (!RULE_FIELDS.has(field)) return `match field "${field}" is not supported (use: ${[...RULE_FIELDS].join(", ")})`;
            const ok = typeof value === "string" || (value && typeof value === "object" && ("equals" in value || "contains" in value || "present" in value));
            if (!ok) return `match.${field} must be text, or { equals | contains | present }`;
        }
    }
    if (!partial || channel !== undefined) {
        if (typeof channel !== "string" || !/^[a-z0-9_\-]{1,64}$/i.test(channel)) return "channel must be 1-64 letters, numbers, - or _";
    }
    return null;
}

const rulesChanged = async (req, action, id) => {
    const workspaceId = req.user.workspaceId;
    invalidateTrackingCache(workspaceId);
    await scheduleRebuildIfNeeded(workspaceId, ["channelRules"], req.user.id);
    return writeAudit(orm(), { workspaceId, actorType: "user", actorUserId: req.user.id, action, targetType: "channel_rule", targetId: id, ip: req.ip ?? null, userAgent: req.headers["user-agent"] ?? null });
};

export const listChannelMappingRules = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const rules = await orm().ChannelMappingRule.where({ workspaceId }).all();
        rules.sort((a, b) => a.priority - b.priority);
        return res.status(200).json({ data: rules });
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const createChannelMappingRule = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const { priority, match, channel, isActive = true } = req.body ?? {};
        const problem = validateRule({ priority, match, channel });
        if (problem) return res.status(400).json({ message: problem });
        const rule = await orm().ChannelMappingRule.create({ workspaceId, priority, match, channel: channel.toLowerCase(), isActive: isActive !== false });
        await rulesChanged(req, "channel_rule.created", rule.id);
        return res.status(201).json({ data: rule, message: "Rule saved. Attribution is being recalculated with it." });
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const updateChannelMappingRule = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const rule = await orm().ChannelMappingRule.where({ id: req.params.id, workspaceId }).first();
        if (!rule) return res.status(404).json({ message: "Rule not found" });
        const allowed = ["priority", "match", "channel", "isActive"];
        const changes = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k)));
        if (!Object.keys(changes).length) return res.status(400).json({ message: "Nothing to update" });
        const problem = validateRule(changes, true);
        if (problem) return res.status(400).json({ message: problem });
        if (changes.channel) changes.channel = changes.channel.toLowerCase();
        await orm().ChannelMappingRule.where({ id: rule.id }).update(changes);
        await rulesChanged(req, "channel_rule.updated", rule.id);
        return res.status(200).json({ message: "Rule updated. Attribution is being recalculated." });
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const deleteChannelMappingRule = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const rule = await orm().ChannelMappingRule.where({ id: req.params.id, workspaceId }).first();
        if (!rule) return res.status(404).json({ message: "Rule not found" });
        await orm().ChannelMappingRule.where({ id: rule.id }).delete();
        await rulesChanged(req, "channel_rule.deleted", rule.id);
        return res.status(204).end();
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

// ────────────────────────────────────────
// Outbound Webhooks
// ────────────────────────────────────────

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

/** Webhook URLs must be public https endpoints (no internal addresses: prevents SSRF). */
function webhookUrlProblem(raw) {
    let u;
    try {
        u = new URL(String(raw));
    } catch {
        return "url is not a valid URL";
    }
    const devLocal = ENV.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(u.hostname);
    if (u.protocol !== "https:" && !devLocal) return "url must use https";
    if (PRIVATE_HOST.test(u.hostname) && !devLocal) return "url must be a public address";
    if (u.username || u.password) return "url must not contain credentials";
    return null;
}

function eventTypesProblem(list) {
    if (!Array.isArray(list) || !list.length) return "eventTypes must be a non-empty array";
    const allowed = new Set([...WEBHOOK_EVENT_TYPES.filter((t) => t !== "ping"), "order.created", "*"]);
    const bad = list.filter((t) => !allowed.has(t));
    return bad.length ? `Unknown event types: ${bad.join(", ")}. Use: ${[...allowed].join(", ")}` : null;
}

export const listWebhookEndpoints = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const hooks = await orm().WebhookEndpoint.where({ workspaceId }).all();
        return res.status(200).json({
            data: hooks.map(({ signingSecretEnc, ...h }) => h),
        });
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const createWebhookEndpoint = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const { url, eventTypes } = req.body ?? {};
        if (!url) return res.status(400).json({ message: "url is required" });
        const urlProblem = webhookUrlProblem(url);
        if (urlProblem) return res.status(400).json({ message: urlProblem });
        const typesProblem = eventTypesProblem(eventTypes);
        if (typesProblem) return res.status(400).json({ message: typesProblem });

        const signingSecret = `whsec_${crypto.randomBytes(32).toString("hex")}`;
        // Encrypt signing secret at rest with AES-256-GCM
        const signingSecretEnc = encryptSecret(signingSecret);

        const hook = await orm().WebhookEndpoint.create({
            workspaceId,
            url,
            eventTypes,
            signingSecretEnc,
            isActive: true,
        });

        await writeAudit(orm(), { workspaceId, actorType: "user", actorUserId: req.user.id, action: "webhook.created", targetType: "webhook_endpoint", targetId: hook.id, metadata: { eventTypes }, ip: req.ip ?? null, userAgent: req.headers["user-agent"] ?? null });
        return res.status(201).json({
            id: hook.id,
            url: hook.url,
            eventTypes: hook.eventTypes,
            isActive: hook.isActive,
            signingSecret, // Shown once only!
            createdAt: hook.createdAt,
        });
    } catch (error) {
        console.error("createWebhookEndpoint:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const updateWebhookEndpoint = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const hook = await orm().WebhookEndpoint.where({ id: req.params.id, workspaceId }).first();
        if (!hook) return res.status(404).json({ message: "Webhook endpoint not found" });

        const changes = {};
        if (typeof req.body?.isActive === "boolean") {
            changes.isActive = req.body.isActive;
            if (req.body.isActive) Object.assign(changes, { consecutiveFailures: 0, disabledReason: null });
        }
        if (req.body?.eventTypes !== undefined) {
            const typesProblem = eventTypesProblem(req.body.eventTypes);
            if (typesProblem) return res.status(400).json({ message: typesProblem });
            changes.eventTypes = req.body.eventTypes;
        }
        if (req.body?.url !== undefined) {
            const urlProblem = webhookUrlProblem(req.body.url);
            if (urlProblem) return res.status(400).json({ message: urlProblem });
            changes.url = req.body.url;
        }
        if (!Object.keys(changes).length) return res.status(400).json({ message: "Nothing to update" });

        await orm().WebhookEndpoint.where({ id: hook.id }).update(changes);
        await writeAudit(orm(), { workspaceId, actorType: "user", actorUserId: req.user.id, action: "webhook.updated", targetType: "webhook_endpoint", targetId: hook.id, metadata: { changedFields: Object.keys(changes) }, ip: req.ip ?? null, userAgent: req.headers["user-agent"] ?? null });
        return res.status(200).json({ message: "Webhook endpoint updated" });
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const deleteWebhookEndpoint = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const hook = await orm().WebhookEndpoint.where({ id: req.params.id, workspaceId }).first();
        if (!hook) return res.status(404).json({ message: "Webhook endpoint not found" });
        try {
            await orm().WebhookDelivery.where({ endpointId: hook.id }).delete();
        } catch {
            /* delivery log not migrated */
        }
        await orm().WebhookEndpoint.where({ id: hook.id }).delete();
        await writeAudit(orm(), { workspaceId, actorType: "user", actorUserId: req.user.id, action: "webhook.deleted", targetType: "webhook_endpoint", targetId: hook.id, ip: req.ip ?? null, userAgent: req.headers["user-agent"] ?? null });
        return res.status(204).end();
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

// ────────────────────────────────────────
// Audit Log
// ────────────────────────────────────────

export const getAuditLog = async (req, res) => {
    try {
        const auditStore = getAuditStore(orm());
        if (!auditStore) {
            // no AuditLog table in this schema: nothing stored, nothing to list
            return res.status(200).json({ data: [], available: false, pagination: { page: 1, limit: 0, total: 0, pages: 0 } });
        }
        const workspaceId = req.user.workspaceId;
        let rows = await auditStore.where({ workspaceId }).all();
        // filters: actorType (user | platform_admin | api_key | system), action prefix (e.g. "auth."), from/to
        if (req.query.actorType) rows = rows.filter((r) => r.actorType === req.query.actorType);
        if (req.query.action) rows = rows.filter((r) => String(r.action).startsWith(String(req.query.action)));
        if (req.query.from) rows = rows.filter((r) => new Date(r.createdAt) >= new Date(req.query.from));
        if (req.query.to) rows = rows.filter((r) => new Date(r.createdAt) <= new Date(req.query.to));
        const users = new Map((await orm().User.all()).filter((u) => rows.some((r) => r.actorUserId === u.id)).map((u) => [u.id, u.name]));
        rows = rows.map((r) => ({ ...r, actorName: r.actorUserId ? users.get(r.actorUserId) ?? null : null }));
        sortDesc(rows, "createdAt");
        if (wantsCsv(req)) return sendCsv(res, "audit-log.csv", rows, ["createdAt", "actorType", "actorName", "action", "targetType", "targetId", "reason", "ip"]);
        return res.status(200).json(paginate(rows, req, "createdAt"));
    } catch (error) {
        console.error("getAuditLog:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

