import { db } from "../src/prisma/db.js";
import bcrypt from 'bcryptjs';

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
                console.error("Workspace update failed:", error);
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
                console.error("Admin update failed:", error);
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
        console.error("Error updating company details:", error);

        return res.status(500).json({
            message: "Internal server error",
        });
    }
};
export const addMember = async (req, res) => {
    try {
        const workspaceId = req.user?.workspaceId ? req.user.workspaceId : req.body?.workspaceId;
        if (!workspaceId) {
            return res.status(400).json({ message: "No workspace id in middleware or body" });
        }
        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
        if (!workspace) {
            return res.status(404).json({ message: "Workspace not found" });
        }
        const userRole = req.user?.role;
        if (userRole === "company_viewer") {
            return res.status(400).json({ message: "know your place, FOOL" });
        }
        const { name, email, password, role } = req.body;
        if (!name || !email || !password || !role) {
            return res.status(400).json({ message: "All credentials are required" });
        }
        const normalizedEmail = email.trim().toLowerCase();
        const existing = await db.orm.public.User.where({ email: normalizedEmail }).first();
        if (existing) {
            return res.status(400).json({ message: "user already exists" });
        }
        const passHash = await bcrypt.hash(password, 10);
        const user = await db.orm.public.User.create({
            workspaceId,
            email: normalizedEmail,
            passwordHash: passHash,
            name: typeof name === 'string' ? name.trim() : name,
            role,
            status: "active",
        });
        const { passwordHash: _, ...safeUser } = user;
        return res.status(201).json({ message: "member created succesfully", user: safeUser });
    } catch (error) {
        console.log(error);
        return res.status(500).json({ message: "Internal server error in addMember" });
    }
}

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

        if (typeof password !== "string" || password.length < 8) {
            return res.status(400).json({ message: "Password must be at least 8 characters long" });
        }

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

        const { passwordHash: _, ...safeUser } = user;

        return res.status(201).json({
            message: "Platform admin created successfully",
            user: safeUser,
        });
    } catch (error) {
        console.error("Error in addPlatformAdmin:", error);
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
        const safeAdmins = admins.map(({ passwordHash, ...admin }) => admin);

        return res.status(200).json({
            message: "Platform admins fetched successfully",
            admins: safeAdmins,
            data: safeAdmins,
        });
    } catch (error) {
        console.error("Error in getPlatformAdmins:", error);
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
        console.error("Error in deletePlatformAdmin:", error);
        return res.status(500).json({ message: "Internal server error in deletePlatformAdmin" });
    }
};


export const updateMember = async (req, res) => {
    try {
        const userId = req.params.userId;
        if (!userId) {
            return res.status(400).json({ message: "No user id found in URL" });
        }
        const { role, name, status } = req.body;
        if (!role && !name && !status) {
            return res.status(400).json({ message: "At least one field is required to update" });
        }
        const updates = {};
        if (role) {
            updates.role = role;
        }
        if (name) {
            updates.name = name;
        }
        if (status) {
            updates.status = status;
        }
        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: "No valid fields to update" });
        }
        const updatedUser = await db.orm.public.User.where({ id: userId }).update(updates);
        if (!updatedUser) {
            return res.status(404).json({ message: "User not found" });
        }
        return res.status(200).json({ message: "User updated successfully" });
    } catch (error) {
        console.log(error);
        return res.status(500).json({ message: "Internal server error in updateMember" });
    }
}

export const deleteUser = async (req, res) => {
    try {

        const userId = req.params.userId;
        if (!userId) {
            return res.status(400).json({ message: "No userId found in URL" });
        }
        await db.orm.public.User.where({ id: userId }).delete();
        return res.status(200).json({ message: "team memeber deleted successfully" });
    } catch (error) {
        console.log(error);
        return res.status(500).json({ message: "Internal server error in user deletion" });
    }
}