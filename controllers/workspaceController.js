/**
 * Company workspace administration: settings, team, locations, rules, webhooks, and audit history.
 * Middleware establishes the user and role; handlers must still scope every database operation to that workspace.
 */

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
    const userRole = req.user.role;
    if(userRole === "company_viewer"){
      return res.status(403).json({message : "Know your place, FOOL"});
    }
    // console.log(req.params);
    const workspaceId = req.user.workspaceId ? req.user.workspaceId : req.params.workspaceId;
    await orm().Workspace.where({id : workspaceId}).delete();
    return res.status(200).json({message : "Workspace deleted successfully"}); 
  } catch (error) {
        console.log(error);
        return res.status(500).json({message : "Internal server error in delete workspace"});
  }
}

const ALLOWED_SETTINGS = new Set([
    "name", "timezone", "weekStart", "reportingCurrency", "industry", "websiteUrl",
    "defaultModel", "lookbackDays", "lookbackOverrides", "consentMode", "rawRetentionMonths",
]);

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

        if (changes.reportingCurrency && !/^[A-Z]{3}$/.test(String(changes.reportingCurrency).toUpperCase())) {
            return res.status(400).json({ message: "reportingCurrency must be a 3-letter ISO code" });
        }
        if (changes.reportingCurrency) changes.reportingCurrency = changes.reportingCurrency.toUpperCase();

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

        const updated = await orm().Workspace.where({ id: workspaceId }).first();
        const { emailVerificationHash, ...safe } = updated;
        return res.status(200).json({ message: "Settings updated", data: safe });
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

        if (!email) return res.status(400).json({ message: "email is required" });
        if (!["company_admin", "company_viewer"].includes(role)) {
            return res.status(400).json({ message: "role must be company_admin or company_viewer" });
        }

        const normalizedEmail = email.trim().toLowerCase();

        // Check if already a user
        const existingUser = await orm().User.where({ email: normalizedEmail }).first();
        if (existingUser && existingUser.workspaceId === workspaceId) {
            return res.status(409).json({ message: "This user is already a member of your workspace" });
        }

        // Check for existing open invite
        const existing = await orm().Invite.where({ workspaceId, email: normalizedEmail }).first();
        if (existing && !existing.acceptedAt && !existing.revokedAt && new Date(existing.expiresAt) > new Date()) {
            return res.status(409).json({ message: "A pending invite already exists for this email" });
        }

        const rawToken = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

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

        // Send invite email (non-blocking)
        try {
            await sendEmail({
                to: normalizedEmail,
                subject: "You've been invited to join a workspace",
                html: `<p>You have been invited to join as <strong>${role}</strong>.</p>
                       <p>Accept your invite: <a href="${process.env.APP_URL || "https://app.example.com"}/accept-invite?token=${rawToken}">Click here</a></p>
                       <p>This link expires in 7 days.</p>`,
            });
        } catch (emailErr) {
            console.error("Failed to send invite email:", emailErr.message);
        }

        return res.status(201).json({ message: "Invite sent", email: normalizedEmail });
    } catch (error) {
        console.error("inviteUser:", error.message);
        return res.status(500).json({ message: "Internal server error" });
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
        if (!password || password.length < 8) return res.status(400).json({ message: "password must be at least 8 characters" });

        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const invite = await orm().Invite.where({ tokenHash }).first();

        if (!invite || invite.revokedAt || invite.acceptedAt) {
            return res.status(400).json({ message: "Invalid or already used invite link" });
        }
        if (new Date(invite.expiresAt) < new Date()) {
            return res.status(400).json({ message: "Invite link has expired" });
        }

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
        const users = await orm().User.where({ workspaceId }).all();
        return res.status(200).json({
            data: users.map(({ passwordHash, ...u }) => u),
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
        const changes = Object.fromEntries(
            Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k))
        );

        if (changes.role && !["company_admin", "company_viewer"].includes(changes.role)) {
            return res.status(400).json({ message: "Invalid role" });
        }
        if (changes.status && !["active", "deactivated"].includes(changes.status)) {
            return res.status(400).json({ message: "Invalid status" });
        }
        if (!Object.keys(changes).length) return res.status(400).json({ message: "Nothing to update" });

        await orm().User.where({ id: user.id }).update(changes);

        await writeAudit(orm(), {
            workspaceId,
            actorType: "user",
            actorUserId: req.user.id,
            action: "team.member_updated",
            targetType: "user",
            targetId: user.id,
            metadata: { changedFields: Object.keys(changes) },
            ip: req.ip ?? null,
            userAgent: req.headers["user-agent"] ?? null,
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
        const { name, timezone = "UTC", currency = "USD", externalIds } = req.body ?? {};
        if (!name) return res.status(400).json({ message: "name is required" });

        const location = await orm().Location.create({
            workspaceId,
            name: name.trim(),
            timezone,
            currency: currency.toUpperCase(),
            externalIds: externalIds ?? null,
        });

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

        await orm().Location.where({ id: location.id }).update(changes);
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

        await orm().Location.where({ id: location.id }).delete();
        return res.status(204).end();
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

// ────────────────────────────────────────
// Channel Mapping Rules
// ────────────────────────────────────────

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
        if (priority === undefined) return res.status(400).json({ message: "priority is required" });
        if (!match || typeof match !== "object") return res.status(400).json({ message: "match must be an object" });
        if (!channel) return res.status(400).json({ message: "channel is required" });

        const rule = await orm().ChannelMappingRule.create({ workspaceId, priority, match, channel, isActive });
        return res.status(201).json({ data: rule });
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

        await orm().ChannelMappingRule.where({ id: rule.id }).update(changes);
        return res.status(200).json({ message: "Rule updated" });
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
        return res.status(204).end();
    } catch (error) {
        return res.status(500).json({ message: "Internal server error" });
    }
};

// ────────────────────────────────────────
// Outbound Webhooks
// ────────────────────────────────────────

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
        if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
            return res.status(400).json({ message: "eventTypes must be a non-empty array" });
        }

        // Validate URL
        try { new URL(url); } catch { return res.status(400).json({ message: "url is not a valid URL" }); }

        const signingSecret = crypto.randomBytes(32).toString("hex");
        // Encrypt signing secret at rest with AES-256-GCM
        const signingSecretEnc = encryptSecret(signingSecret);

        const hook = await orm().WebhookEndpoint.create({
            workspaceId,
            url,
            eventTypes,
            signingSecretEnc,
            isActive: true,
        });

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
        if (typeof req.body?.isActive === "boolean") changes.isActive = req.body.isActive;
        if (Array.isArray(req.body?.eventTypes)) changes.eventTypes = req.body.eventTypes;
        if (!Object.keys(changes).length) return res.status(400).json({ message: "Nothing to update" });

        await orm().WebhookEndpoint.where({ id: hook.id }).update(changes);
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
        await orm().WebhookEndpoint.where({ id: hook.id }).delete();
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
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        const offset = (page - 1) * limit;

        const countResult = await auditStore
            .where({ workspaceId })
            .aggregate((agg) => ({ total: agg.count() }));
        const total = countResult?.total || 0;

        const data = await auditStore
            .where({ workspaceId })
            .orderBy((l) => l.createdAt.desc())
            .limit(limit)
            .offset(offset)
            .all();

        return res.status(200).json({
            data,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error("getAuditLog:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};
