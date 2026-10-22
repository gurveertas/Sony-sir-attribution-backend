import bcrypt from "bcryptjs";
import genSlug from "../utils/genSlug.js";
import { db } from "../src/prisma/db.js";
import genToken from "../utils/genToken.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { sendEmail } from "../services/emailServices.js";
import fs from "fs";
import path from "path";
import ENV from "../utils/env.js";

export const registerCompany = async (req, res) => {
    try {
        const {
            name,
            email,
            password,
            adminName,
            country,
            timezone = "UTC",
            currency = "USD",
            industry,
            dataRegion,
        } = req.body;

        if (!name)
            return res.status(400).json({ message: "Company name is required" });
        if (!email)
            return res.status(400).json({ message: "Admin email is required" });
        if (!password)
            return res.status(400).json({ message: "Password is required" });
        if (!country)
            return res
                .status(400)
                .json({ message: "Country (ISO 2-char) is required" });
        if (country.length !== 2)
            return res
                .status(400)
                .json({ message: "Country must be a 2-character ISO code" });

        const derivedRegion =
            dataRegion ||
            (country.toUpperCase() === "IN"
                ? "in"
                : ["US", "CA"].includes(country.toUpperCase())
                    ? "us"
                    : "eu");

        const baseSlug = genSlug(name);
        const slug = `${baseSlug}-${Math.random().toString(36).substring(2, 6)}`;

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        const emailVerificationToken = crypto.randomBytes(32).toString("hex");
        const emailVerificationExpiry = new Date(Date.now() + 15 * 60 * 1000);
        const tokenHash = crypto.createHash('sha256').update(emailVerificationToken).digest('hex');
        const htmlTemplate = fs
            .readFileSync(
                path.join(process.cwd(), "templates", "signupVerification.html"),
                "utf-8"
            )
            .replace(/\{\{name\}\}/g, adminName || name)
            .replace(
                /\{\{verificationUrl\}\}/g,
                "https://asftas.vercel.app/verify-user?verifytoken=" +
                emailVerificationToken
            );

        const result = await db.transaction(async (tx) => {
            const workspace = await tx.orm.public.Workspace.create({
                name,
                slug,
                country: country.toUpperCase(),
                dataRegion: derivedRegion,
                industry: industry || null,
                // websiteUrl: websiteUrl || null,
                timezone,
                reportingCurrency: currency.toUpperCase(),
                status: "active",
                emailVerificationHash: tokenHash,
                emailVerificationExpires: emailVerificationExpiry,
            });

            const adminUser = await tx.orm.public.User.create({
                workspaceId: workspace.id,
                email: email.toLowerCase().trim(),
                name: adminName || name,
                passwordHash,
                role: "company_admin",
                status: "active",
            });
            const user = {
                id : adminUser.id,
                role : adminUser.role,
                name : adminUser.name,
                email : adminUser.email,
                workspaceId : workspace.id,
            }
            genToken(user, res);
            return { workspace, adminUser };
        });

        try {
            await sendEmail({
                to: email.toLowerCase().trim(),
                subject: "Email verification",
                html: htmlTemplate,
            });
        } catch (emailErr) {
            console.error("Failed to send verification email:", emailErr);
        }
        return res.status(201).json({
            message: "Company registered successfully. Verification email sent.",
            workspaceId: result.workspace.id,
            slug: result.workspace.slug,
            userId: result.adminUser.id,
        });
    } catch (error) {
        console.error("Error creating company:", error);
        if (error.code === "23505") {
            // Postgres unique constraint violation
            return res
                .status(409)
                .json({ message: "Email or company slug already exists" });
        }
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const verifyUser = async (req, res) => {
    try {
        const token =
            req.query.verifytoken || req.body.verifytoken || req.params.verifytoken;
        if (!token) {
            return res.status(400).json({ message: "Verification token not found" });
        }

        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const workspace = await db.orm.public.Workspace.where({
            emailVerificationHash: tokenHash,
            emailVerificationExpires: { gt: new Date() },
        }).first();

        if (!workspace) {
            return res
                .status(400)
                .json({ message: "Invalid or expired email verification link" });
        }

        await db.transaction(async (tx) => {
            await tx.orm.public.Workspace.where({ id: workspace.id }).update({
                status: "active",
                emailVerificationHash: null,
                emailVerificationExpires: null,
            });

            await tx.orm.public.User.where({
                workspaceId: workspace.id,
                role: "company_admin",
            }).update({
                status: "active",
                emailVerifiedAt: new Date().toISOString(),
            });
        });

        return res.status(200).json({
            message: "Email verified successfully. You can now log in.",
            workspaceId: workspace.id,
            slug: workspace.slug,
        });
    } catch (error) {
        console.error("Error in verifyUser:", error);
        return res
            .status(500)
            .json({ message: "Internal server error in verify email" });
    }
};

export const companyLogin = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({
                message: "Email and password are required",
            });
        }
        const normalizedEmail = email.trim().toLowerCase();
        const user = await db.orm.public.User.where({
            email: normalizedEmail,
        }).first();

        if (!user) {
            return res.status(401).json({
                message: "Invalid email or password",
            });
        }
        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) {
            return res.status(401).json({
                message: "Invalid email or password",
            });
        }

        // Only active users may start a session.
        if (user.status !== "active") {
            return res.status(403).json({ message: "Account is not active" });
        }

        // Platform admins may be global users without a workspace. Every other
        // account must belong to an active workspace before receiving a cookie.
        if (user.workspaceId) {
            const workspace = await db.orm.public.Workspace.where({ id: user.workspaceId }).first();
            if (
                !workspace ||
                workspace.status !== "active" ||
                workspace.emailVerificationHash
            ) {
                return res.status(403).json({ message: "Workspace is not active" });
            }
        } else if (user.role !== "platform_admin") {
            return res.status(403).json({ message: "Workspace is not active" });
        }

        genToken(user, res);
        return res.status(200).json({
            message: "User verified",
            status: user.status,
        });
    } catch (err) {
        console.log(err);
        return res.status(500).json({
            message: "Internal server error from login controller",
        });
    }
};

export const sendMe = async (req, res) => {
    try {
        const token = req.cookies.user_token;
        if (!token) {
            return res.status(400).json({ message: "No token provided in cookies" });
        }
        const decoded = jwt.verify(token, ENV.JWT_SECRET);
        if (!decoded) {
            return res.status(400).json({ message: "Token didn't got decoded" });
        }
        return res.status(200).json({ message: "Token decoded", decoded });
    } catch (error) {
        return res.status(500).json({
            message: "Internal server error while gettin jwt token for user",
        });
    }
};

export const forgotPass = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const user = await db.orm.public.User.where({
            email: normalizedEmail,
        }).first();

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Generate token tied to current passwordHash (auto-invalidates upon password change)
        const secret = (ENV.JWT_SECRET || "default_jwt_secret") + user.passwordHash;
        const resetToken = jwt.sign(
            { userId: user.id, email: user.email, type: "password_reset" },
            secret,
            { expiresIn: "1h" }
        );

        const resetUrl = `https://asftas.vercel.app/reset-password?token=${resetToken}`;

        const templatePath = path.join(process.cwd(), "templates", "passwordReset.html");
        let htmlTemplate = "";
        try {
            htmlTemplate = fs.readFileSync(templatePath, "utf-8")
                .replace(/\{\{name\}\}/g, user.name || "User")
                .replace(/\{\{resetUrl\}\}/g, resetUrl);
        } catch (readErr) {
            console.error("Failed to read passwordReset.html template:", readErr.message);
            htmlTemplate = `<p>Hi ${user.name},</p><p>Reset your password by visiting: <a href="${resetUrl}">${resetUrl}</a></p>`;
        }

        try {
            await sendEmail({
                to: normalizedEmail,
                subject: "Reset Your Password",
                html: htmlTemplate,
            });
        } catch (emailErr) {
            console.error("Failed to send password reset email:", emailErr.message);
        }

        return res.status(200).json({
            message: "Password reset instructions have been sent to your email.",
        });
    } catch (error) {
        console.error("Error in forgotPass:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const resetPassword = async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token) {
            return res.status(400).json({ message: "Reset token is required" });
        }
        if (!newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
            return res.status(400).json({ message: "Password must be at least 6 characters long" });
        }

        const decoded = jwt.decode(token);
        if (!decoded || !decoded.userId || decoded.type !== "password_reset") {
            return res.status(400).json({ message: "Invalid reset token" });
        }

        const user = await db.orm.public.User.where({ id: decoded.userId }).first();
        if (!user) {
            return res.status(400).json({ message: "Invalid or expired reset token" });
        }

        // Verify token with user's current passwordHash
        const secret = (ENV.JWT_SECRET || "default_jwt_secret") + user.passwordHash;
        try {
            jwt.verify(token, secret);
        } catch (verifyErr) {
            return res.status(400).json({ message: "Reset token has expired or is invalid" });
        }

        const saltRounds = 10;
        const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

        await db.orm.public.User.where({ id: user.id }).update({
            passwordHash: newPasswordHash,
        });

        return res.status(200).json({
            message: "Password has been reset successfully. You can now log in with your new password.",
        });
    } catch (error) {
        console.error("Error in resetPassword:", error);
        return res.status(500).json({ message: "Internal server error while resetting password" });
    }
};

export const userLogout = async (req, res) => {
    try {
        res.clearCookie("user_token", {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            path: "/",
        });
        return res.status(200).json({ message: "Logged out successfully" });
    } catch (error) {
        console.error("Logout error:", error.message);
        return res.status(500).json({ message: "Internal server error during logout" });
    }
};

