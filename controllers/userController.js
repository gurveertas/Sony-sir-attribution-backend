import { db } from "../src/prisma/db.js";
import bcrypt from 'bcryptjs';
import { passwordProblem } from "../utils/passwordPolicy.js";
import { writeAudit } from "../services/audit.js";

export const updateDetails = async (req, res) => {
    try {
        const {
            name,
            adminName,
            country,
            timezone,
            currency,
            industry,
        } = req.body;

        const userId = req.user?.id;
        const workspaceId = req.user?.workspaceId;

        if (!userId || !workspaceId) {
            return res.status(401).json({
                message: "Unauthorized",
            });
        }

        const allowedFields = [
            "name",
            "adminName",
            "country",
            "timezone",
            "currency",
            "industry",
        ];

        if (
            !allowedFields.some((field) =>
                Object.prototype.hasOwnProperty.call(req.body, field)
            )
        ) {
            return res.status(400).json({
                message: "At least one field is required to update",
            });
        }

        if (
            name !== undefined &&
            (typeof name !== "string" || !name.trim())
        ) {
            return res.status(400).json({
                message: "Company name cannot be empty",
            });
        }

        if (
            adminName !== undefined &&
            (typeof adminName !== "string" || !adminName.trim())
        ) {
            return res.status(400).json({
                message: "Admin name cannot be empty",
            });
        }

        if (
            country !== undefined &&
            (typeof country !== "string" ||
                !/^[a-zA-Z]{2}$/.test(country))
        ) {
            return res.status(400).json({
                message: "Country must be a 2-character ISO code",
            });
        }

        if (
            currency !== undefined &&
            (typeof currency !== "string" ||
                !/^[a-zA-Z]{3}$/.test(currency))
        ) {
            return res.status(400).json({
                message: "Currency must be a 3-character code",
            });
        }

        if (
            timezone !== undefined &&
            (typeof timezone !== "string" || !timezone.trim())
        ) {
            return res.status(400).json({
                message: "Timezone cannot be empty",
            });
        }

        if (
            industry !== undefined &&
            industry !== null &&
            typeof industry !== "string"
        ) {
            return res.status(400).json({
                message: "Industry must be a string or null",
            });
        }

        const workspaceUpdates = {};

        if (name !== undefined) {
            workspaceUpdates.name = name.trim();
        }

        if (country !== undefined) {
            workspaceUpdates.country = country.toUpperCase();
        }

        if (timezone !== undefined) {
            workspaceUpdates.timezone = timezone.trim();
        }

        if (currency !== undefined) {
            workspaceUpdates.reportingCurrency = currency.toUpperCase();
        }

        if (industry !== undefined) {
            workspaceUpdates.industry =
                industry === null ? null : industry.trim();
        }

        let workspace = null;
        let user = null;

        // Update company information
        if (Object.keys(workspaceUpdates).length > 0) {
            try {
                await db.orm.public.Workspace.where({ id: workspaceId }).update(workspaceUpdates);
                workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
                if (!workspace) {
                    return res.status(404).json({
                        message: "Workspace not found",
                    });
                }
                // Remove sensitive fields
                const { emailVerificationHash, emailVerificationExpires, ...safe } = workspace;
                workspace = safe;
            } catch (error) {
                console.error("Workspace update failed:", error?.message ?? error);
                if (error?.code === "23505") {
                    return res.status(409).json({
                        message: "A unique constraint was violated",
                    });
                }
                return res.status(500).json({
                    message: "Failed to update company details",
                });
            }
        }

        // Update admin information
        if (adminName !== undefined) {
            try {
                await db.orm.public.User.where({ id: userId, workspaceId }).update({ name: adminName.trim() });
                const updatedUser = await db.orm.public.User.where({ id: userId }).first();
                if (!updatedUser) {
                    return res.status(404).json({
                        message: "Admin user not found in this workspace",
                    });
                }
                const { passwordHash, ...safeUser } = updatedUser;
                user = safeUser;
            } catch (error) {
                console.error("Admin update failed:", error?.message ?? error);
                return res.status(500).json({
                    message: "Failed to update admin details",
                });
            }
        }

        return res.status(200).json({
            message: "Company details updated successfully",
            workspace,
            user,
        });
    } catch (error) {
        console.error("Error updating company details:", error?.message ?? error);

        return res.status(500).json({
            message: "Internal server error",
        });
    }
};
const COMPANY_ROLES = ["company_admin", "company_viewer"];
const USER_STATUSES = ["active", "deactivated"];

const safeUser = ({ passwordHash: _p, twoFactorSecretEnc: _t, ...rest }) => rest;

/**
 * Who may manage `target`?
 *   - a company admin: only users of their own company (never platform admins)
 *   - a platform admin: any company user (platform admins are managed through /platform-admins)
 */
function canManage(actor, target) {
    if (!target || target.role === "platform_admin") return false;
    if (actor.role === "platform_admin") return true;
    return actor.role === "company_admin" && Boolean(actor.workspaceId) && target.workspaceId === actor.workspaceId;
}

async function countActiveAdmins(workspaceId) {
    const users = await db.orm.public.User.where({ workspaceId, role: "company_admin" }).all();
    return users.filter((u) => u.status === "active").length;
}

/**
 * POST /api/user/add-member
 * company_admin: adds a user to their own company. platform_admin: must name the company in body.workspaceId.
 * Roles are limited to company_admin / company_viewer — nobody can create a platform admin here.
 */
export const addMember = async (req, res) => {
    try {
        const actor = req.user;
        if (!actor || !["company_admin", "platform_admin"].includes(actor.role)) {
            return res.status(403).json({ message: "You do not have permission for this action" });
        }
        const workspaceId = actor.role === "platform_admin" ? req.body?.workspaceId : actor.workspaceId;
        if (!workspaceId) return res.status(400).json({ message: "workspaceId is required" });

        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
        if (!workspace) return res.status(404).json({ message: "Workspace not found" });

        const { name, email, password, role } = req.body ?? {};
        if (!name || !email || !password || !role) {
            return res.status(400).json({ message: "name, email, password and role are required" });
        }
        if (!COMPANY_ROLES.includes(role)) {
            return res.status(400).json({ message: "role must be company_admin or company_viewer" });
        }
        const normalizedEmail = String(email).trim().toLowerCase();
        const problem = passwordProblem(password, normalizedEmail);
        if (problem) return res.status(400).json({ message: problem });

        const existing = await db.orm.public.User.where({ email: normalizedEmail }).first();
        if (existing) return res.status(409).json({ message: "A user with this email already exists" });

        const passHash = await bcrypt.hash(password, 10);
        const user = await db.transaction(async (tx) => {
            const created = await tx.orm.public.User.create({
                workspaceId,
                email: normalizedEmail,
                passwordHash: passHash,
                name: String(name).trim(),
                role,
                status: "active",
            });
            await writeAudit(tx.orm.public, {
                workspaceId,
                actorType: actor.role === "platform_admin" ? "platform_admin" : "user",
                actorUserId: actor.id,
                action: "user.created",
                targetType: "user",
                targetId: created.id,
                metadata: { role },
                ip: req.ip ?? null,
                userAgent: req.headers?.["user-agent"] ?? null,
            });
            return created;
        });
        return res.status(201).json({ message: "Member created successfully", user: safeUser(user) });
    } catch (error) {
        console.error("addMember error:", error.message);
        return res.status(500).json({ message: "Internal server error in addMember" });
    }
};

export const addPlatformAdmin = async (req, res) => {
    try {
        const userRole = req.user?.role;
        if (userRole !== "platform_admin") {
            return res.status(403).json({ message: "Only platform admins can add another platform admin" });
        }

        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ message: "All credentials are required" });
        }

        if (typeof name !== "string" || !name.trim()) {
            return res.status(400).json({ message: "Name cannot be empty" });
        }

        if (typeof email !== "string" || !email.trim()) {
            return res.status(400).json({ message: "Email cannot be empty" });
        }

        const passwordError = passwordProblem(password, email);
        if (passwordError) return res.status(400).json({ message: passwordError });

        const normalizedEmail = email.trim().toLowerCase();
        const existing = await db.orm.public.User.where({ email: normalizedEmail }).first();
        if (existing) {
            return res.status(400).json({ message: "User already exists" });
        }

        const passHash = await bcrypt.hash(password, 10);
        const user = await db.orm.public.User.create({
            workspaceId: null,
            email: normalizedEmail,
            passwordHash: passHash,
            name: name.trim(),
            role: "platform_admin",
            status: "active",
            emailVerifiedAt: new Date().toISOString(),
        });

        await writeAudit(db.orm.public, {
            workspaceId: null,
            actorType: "platform_admin",
            actorUserId: req.user.id,
            action: "platform_admin.created",
            targetType: "user",
            targetId: user.id,
            ip: req.ip ?? null,
            userAgent: req.headers?.["user-agent"] ?? null,
        });

        return res.status(201).json({
            message: "Platform admin created successfully",
            user: safeUser(user),
        });
    } catch (error) {
        console.error("Error in addPlatformAdmin:", error?.message ?? error);
        return res.status(500).json({ message: "Internal server error in addPlatformAdmin" });
    }
};

export const getPlatformAdmins = async (req, res) => {
    try {
        const userRole = req.user?.role;
        if (userRole !== "platform_admin") {
            return res.status(403).json({ message: "Only platform admins can view platform admins" });
        }

        const admins = await db.orm.public.User.where({ role: "platform_admin" }).all();
        const safeAdmins = admins.map(safeUser);

        return res.status(200).json({
            message: "Platform admins fetched successfully",
            admins: safeAdmins,
            data: safeAdmins,
        });
    } catch (error) {
        console.error("Error in getPlatformAdmins:", error?.message ?? error);
        return res.status(500).json({ message: "Internal server error in getPlatformAdmins" });
    }
};

export const deletePlatformAdmin = async (req, res) => {
    try {
        const userRole = req.user?.role;
        if (userRole !== "platform_admin") {
            return res.status(403).json({ message: "Only platform admins can delete a platform admin" });
        }

        const userId = req.params.userId || req.params.id;
        if (!userId) {
            return res.status(400).json({ message: "User ID is required" });
        }

        if (req.user?.id === userId) {
            return res.status(400).json({ message: "You cannot delete your own account" });
        }

        const user = await db.orm.public.User.where({ id: userId }).first();
        if (!user) {
            return res.status(404).json({ message: "Platform admin not found" });
        }

        if (user.role !== "platform_admin") {
            return res.status(400).json({ message: "Target user is not a platform admin" });
        }

        const admins = await db.orm.public.User.where({ role: "platform_admin" }).all();
        if (admins.length <= 1) {
            return res.status(400).json({ message: "Cannot delete the only remaining platform admin" });
        }

        await db.orm.public.User.where({ id: userId }).delete();

        return res.status(200).json({
            message: "Platform admin deleted successfully",
        });
    } catch (error) {
        console.error("Error in deletePlatformAdmin:", error?.message ?? error);
        return res.status(500).json({ message: "Internal server error in deletePlatformAdmin" });
    }
};


/**
 * PATCH /api/user/:userId — change a company user's name, role or status.
 * Scoped: a company admin can only touch users of their own company; nobody can grant platform_admin.
 */
export const updateMember = async (req, res) => {
    try {
        const actor = req.user;
        const userId = req.params.userId;
        if (!userId) return res.status(400).json({ message: "No user id found in URL" });

        const target = await db.orm.public.User.where({ id: userId }).first();
        if (!target || !canManage(actor, target)) return res.status(404).json({ message: "User not found" });

        const { role, name, status } = req.body ?? {};
        const updates = {};
        if (role !== undefined) {
            if (!COMPANY_ROLES.includes(role)) return res.status(400).json({ message: "role must be company_admin or company_viewer" });
            updates.role = role;
        }
        if (status !== undefined) {
            if (!USER_STATUSES.includes(status)) return res.status(400).json({ message: "status must be active or deactivated" });
            updates.status = status;
        }
        if (name !== undefined) {
            if (typeof name !== "string" || !name.trim()) return res.status(400).json({ message: "name cannot be empty" });
            updates.name = name.trim();
        }
        if (!Object.keys(updates).length) return res.status(400).json({ message: "At least one of role, name or status is required" });

        const losesAdmin =
            target.role === "company_admin" && target.status === "active" &&
            ((updates.role && updates.role !== "company_admin") || updates.status === "deactivated");
        if (losesAdmin && (await countActiveAdmins(target.workspaceId)) <= 1) {
            return res.status(409).json({ code: "last_admin", message: "A company must keep at least one active admin" });
        }

        await db.transaction(async (tx) => {
            await tx.orm.public.User.where({ id: target.id }).update(updates);
            await writeAudit(tx.orm.public, {
                workspaceId: target.workspaceId,
                actorType: actor.role === "platform_admin" ? "platform_admin" : "user",
                actorUserId: actor.id,
                action: "user.updated",
                targetType: "user",
                targetId: target.id,
                metadata: { changedFields: Object.keys(updates), role: updates.role, status: updates.status },
                ip: req.ip ?? null,
                userAgent: req.headers?.["user-agent"] ?? null,
            });
        });
        return res.status(200).json({ message: "User updated successfully" });
    } catch (error) {
        console.error("updateMember error:", error.message);
        return res.status(500).json({ message: "Internal server error in updateMember" });
    }
};

/**
 * DELETE /api/user/:userId — remove a company user (same scoping as updateMember).
 * A user who is referenced elsewhere (e.g. sent invites) is deactivated instead of deleted.
 */
export const deleteUser = async (req, res) => {
    try {
        const actor = req.user;
        const userId = req.params.userId;
        if (!userId) return res.status(400).json({ message: "No userId found in URL" });
        if (userId === actor?.id) return res.status(400).json({ message: "You cannot delete your own account" });

        const target = await db.orm.public.User.where({ id: userId }).first();
        if (!target || !canManage(actor, target)) return res.status(404).json({ message: "User not found" });
        if (target.role === "company_admin" && target.status === "active" && (await countActiveAdmins(target.workspaceId)) <= 1) {
            return res.status(409).json({ code: "last_admin", message: "A company must keep at least one active admin" });
        }

        let outcome = "deleted";
        try {
            await db.orm.public.User.where({ id: target.id }).delete();
        } catch (err) {
            if (err?.code !== "23503") throw err;
            await db.orm.public.User.where({ id: target.id }).update({ status: "deactivated" });
            outcome = "deactivated";
        }
        await writeAudit(db.orm.public, {
            workspaceId: target.workspaceId,
            actorType: actor.role === "platform_admin" ? "platform_admin" : "user",
            actorUserId: actor.id,
            action: outcome === "deleted" ? "user.deleted" : "user.deactivated",
            targetType: "user",
            targetId: target.id,
            ip: req.ip ?? null,
            userAgent: req.headers?.["user-agent"] ?? null,
        });
        return res.status(200).json({
            message: outcome === "deleted" ? "Team member deleted successfully" : "Team member has history, so it was deactivated instead",
            outcome,
        });
    } catch (error) {
        console.error("deleteUser error:", error.message);
        return res.status(500).json({ message: "Internal server error in user deletion" });
    }
};

/**
 * PATCH /api/user/platform-admins/:userId — rename or (de)activate another platform admin.
 * The last active platform admin cannot be deactivated.
 */
export const updatePlatformAdmin = async (req, res) => {
    try {
        if (req.user?.role !== "platform_admin") return res.status(403).json({ message: "Platform admins only" });
        const target = await db.orm.public.User.where({ id: req.params.userId }).first();
        if (!target || target.role !== "platform_admin") return res.status(404).json({ message: "Platform admin not found" });

        const { name, status } = req.body ?? {};
        const updates = {};
        if (name !== undefined) {
            if (typeof name !== "string" || !name.trim()) return res.status(400).json({ message: "name cannot be empty" });
            updates.name = name.trim();
        }
        if (status !== undefined) {
            if (!USER_STATUSES.includes(status)) return res.status(400).json({ message: "status must be active or deactivated" });
            if (status === "deactivated") {
                if (target.id === req.user.id) return res.status(400).json({ message: "You cannot deactivate your own account" });
                const admins = await db.orm.public.User.where({ role: "platform_admin" }).all();
                if (admins.filter((a) => a.status === "active").length <= 1) {
                    return res.status(409).json({ message: "Cannot deactivate the only remaining platform admin" });
                }
            }
            updates.status = status;
        }
        if (!Object.keys(updates).length) return res.status(400).json({ message: "name or status is required" });

        await db.orm.public.User.where({ id: target.id }).update(updates);
        await writeAudit(db.orm.public, {
            workspaceId: null,
            actorType: "platform_admin",
            actorUserId: req.user.id,
            action: "platform_admin.updated",
            targetType: "user",
            targetId: target.id,
            metadata: { changedFields: Object.keys(updates) },
            ip: req.ip ?? null,
            userAgent: req.headers?.["user-agent"] ?? null,
        });
        return res.status(200).json({ message: "Platform admin updated" });
    } catch (error) {
        console.error("updatePlatformAdmin error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};
