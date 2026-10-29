/**
 * Authentication — /api/auth/*
 *
 *   POST /company/register     sign-up (company + first admin), email verification sent
 *   POST /verify-user          confirm the email link
 *   POST /resend-verification  new verification link
 *   POST /user/login           password login (+ throttling and lock-out); returns a 2FA challenge when enabled
 *   POST /2fa/verify           finish a 2FA login with a 6-digit code
 *   POST /2fa/setup | /2fa/enable | /2fa/disable   two-factor enrolment (required for platform admins)
 *   POST /user/forgotpass, /user/reset-password    password reset (no account enumeration)
 *   GET  /me, POST /logout
 *
 * Every login, failed login and password change is written to the audit log (D9).
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import genSlug from "../utils/genSlug.js";
import { db } from "../src/prisma/db.js";
import genToken from "../utils/genToken.js";
import { sendEmail } from "../services/emailServices.js";
import ENV from "../utils/env.js";
import { passwordProblem } from "../utils/passwordPolicy.js";
import { writeAudit } from "../services/audit.js";
import { isValidTimeZone } from "../utils/timezone.js";
import { encryptSecret, decryptSecret } from "../utils/crypto.js";
import { generateSecret, verifyTotp, otpauthUrl } from "../utils/totp.js";
import { platformAdmin2faRequired } from "../middlewares/protectRoute.js";
import { frontendBase } from "../utils/frontendUrl.js";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
const CHALLENGE_TTL = "5m";

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const audit = (entry, req) =>
    writeAudit(db.orm.public, { ip: req.ip ?? null, userAgent: req.headers?.["user-agent"] ?? null, ...entry }).catch((e) =>
        console.error("audit write failed:", e.message),
    );

// Per IP + email attempt window, on top of the per-account lock (login throttling, 4.10).
const attempts = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of attempts) if (now - v.start > LOCK_MS) attempts.delete(k);
}, 60_000).unref();
function throttled(key) {
    const now = Date.now();
    const e = attempts.get(key);
    if (!e || now - e.start > LOCK_MS) {
        attempts.set(key, { start: now, count: 1 });
        return false;
    }
    e.count++;
    return e.count > 20;
}

function verificationEmail(name, token, base = ENV.FRONTEND_URL) {
    const url = `${base}/verify-user?verifytoken=${token}`;
    try {
        return fs
            .readFileSync(path.join(process.cwd(), "templates", "signupVerification.html"), "utf-8")
            .replace(/\{\{name\}\}/g, escapeHtml(name))
            .replace(/\{\{verificationUrl\}\}/g, url);
    } catch {
        return `<p>Hi ${escapeHtml(name)},</p><p>Confirm your email: <a href="${url}">${url}</a></p>`;
    }
}
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ── Sign-up ─────────────────────────────────────────────────────────────────

/**
 * Body: name* (company), email* + password* + adminName (first admin), country* (ISO-2), timezone (IANA),
 *       currency (ISO-3), websiteUrl, industry, weekStart (0-6), dataRegion
 */
export const registerCompany = async (req, res) => {
    try {
        const { name, email, password, adminName, country, timezone = "UTC", currency = "USD", industry, dataRegion, websiteUrl, weekStart } = req.body ?? {};

        if (!name || typeof name !== "string" || !name.trim()) return res.status(400).json({ message: "Company name is required", code: "validation_error" });
        if (!email || !String(email).includes("@")) return res.status(400).json({ message: "A valid admin email is required", code: "validation_error" });
        const normalizedEmail = String(email).trim().toLowerCase();
        const pwProblem = passwordProblem(password, normalizedEmail);
        if (pwProblem) return res.status(400).json({ message: pwProblem, code: "weak_password" });
        if (!country || !/^[A-Za-z]{2}$/.test(country)) return res.status(400).json({ message: "Country must be a 2-character ISO code", code: "validation_error" });
        if (!isValidTimeZone(timezone)) return res.status(400).json({ message: "timezone must be an IANA name such as Asia/Kolkata", code: "validation_error" });
        if (!/^[A-Za-z]{3}$/.test(String(currency))) return res.status(400).json({ message: "currency must be a 3-letter ISO code", code: "validation_error" });
        let site = null;
        if (websiteUrl) {
            try {
                const u = new URL(String(websiteUrl).match(/^https?:\/\//) ? websiteUrl : `https://${websiteUrl}`);
                site = u.origin;
            } catch {
                return res.status(400).json({ message: "websiteUrl is not a valid URL", code: "validation_error" });
            }
        }
        const ws = weekStart === undefined ? 1 : Number(weekStart);
        if (!Number.isInteger(ws) || ws < 0 || ws > 6) return res.status(400).json({ message: "weekStart must be 0-6", code: "validation_error" });

        const existing = await db.orm.public.User.where({ email: normalizedEmail }).first();
        if (existing) return res.status(409).json({ message: "Email is already registered", code: "conflict" });

        const cc = country.toUpperCase();
        const derivedRegion = dataRegion || (cc === "IN" ? "in" : ["US", "CA"].includes(cc) ? "us" : "eu");
        const slug = `${genSlug(name)}-${crypto.randomBytes(3).toString("hex")}`;
        const passwordHash = await bcrypt.hash(password, 10);
        const verificationToken = crypto.randomBytes(32).toString("hex");

        const result = await db.transaction(async (tx) => {
            const workspace = await tx.orm.public.Workspace.create({
                name: name.trim(),
                slug,
                country: cc,
                dataRegion: derivedRegion,
                industry: industry || null,
                websiteUrl: site,
                timezone,
                weekStart: ws,
                reportingCurrency: String(currency).toUpperCase(),
                // pending until a platform admin approves, when manual approval is switched on
                status: ENV.REQUIRE_WORKSPACE_APPROVAL ? "pending" : "active",
                emailVerificationHash: sha256(verificationToken),
                emailVerificationExpires: new Date(Date.now() + VERIFICATION_TTL_MS).toISOString(),
            });
            const adminUser = await tx.orm.public.User.create({
                workspaceId: workspace.id,
                email: normalizedEmail,
                name: (adminName || name).trim(),
                passwordHash,
                role: "company_admin",
                status: "active",
                passwordChangedAt: new Date().toISOString(),
            });
            await writeAudit(tx.orm.public, {
                workspaceId: workspace.id,
                actorType: "user",
                actorUserId: adminUser.id,
                action: "workspace.created",
                targetType: "workspace",
                targetId: workspace.id,
                metadata: { country: cc, timezone, currency: String(currency).toUpperCase(), approvalRequired: ENV.REQUIRE_WORKSPACE_APPROVAL },
                ip: req.ip ?? null,
                userAgent: req.headers?.["user-agent"] ?? null,
            });
            return { workspace, adminUser };
        });

        try {
            await sendEmail({ to: normalizedEmail, subject: "Confirm your email address", html: verificationEmail(adminName || name, verificationToken, frontendBase(req)) });
        } catch (emailErr) {
            console.error("Failed to send verification email:", emailErr.message);
        }

        return res.status(201).json({
            message: "Company registered. Check your inbox to confirm your email address.",
            workspaceId: result.workspace.id,
            slug: result.workspace.slug,
            userId: result.adminUser.id,
            status: result.workspace.status,
            approvalRequired: ENV.REQUIRE_WORKSPACE_APPROVAL,
        });
    } catch (error) {
        if (error.code === "23505") return res.status(409).json({ message: "Email or company slug already exists", code: "conflict" });
        console.error("registerCompany error:", error.message);
        return res.status(500).json({ message: "Internal server error", code: "internal_error" });
    }
};

/** POST /api/auth/verify-user  { verifytoken } */
export const verifyUser = async (req, res) => {
    try {
        const token = req.query?.verifytoken || req.body?.verifytoken || req.params?.verifytoken;
        if (!token) return res.status(400).json({ message: "Verification token not found", code: "validation_error" });

        const workspace = await db.orm.public.Workspace.where({ emailVerificationHash: sha256(String(token)) }).first();
        if (!workspace || !workspace.emailVerificationExpires || new Date(workspace.emailVerificationExpires) < new Date()) {
            return res.status(400).json({ message: "Invalid or expired email verification link", code: "invalid_token" });
        }

        await db.transaction(async (tx) => {
            await tx.orm.public.Workspace.where({ id: workspace.id }).update({ emailVerificationHash: null, emailVerificationExpires: null });
            await tx.orm.public.User.where({ workspaceId: workspace.id, role: "company_admin" }).update({ emailVerifiedAt: new Date().toISOString() });
            await writeAudit(tx.orm.public, { workspaceId: workspace.id, actorType: "system", action: "workspace.email_verified", targetType: "workspace", targetId: workspace.id });
        });

        return res.status(200).json({
            message: workspace.status === "pending" ? "Email verified. Your company is waiting for approval; we will email you when it is live." : "Email verified successfully. You can now log in.",
            workspaceId: workspace.id,
            slug: workspace.slug,
            status: workspace.status,
        });
    } catch (error) {
        console.error("verifyUser error:", error.message);
        return res.status(500).json({ message: "Internal server error in verify email", code: "internal_error" });
    }
};

/** POST /api/auth/resend-verification { email } — always answers 200 (no account enumeration). */
export const resendVerification = async (req, res) => {
    const generic = { message: "If that account still needs verification, a new link is on its way." };
    try {
        const email = String(req.body?.email ?? "").trim().toLowerCase();
        if (!email || throttled(`verify:${email}`)) return res.status(200).json(generic);
        const user = await db.orm.public.User.where({ email }).first();
        if (!user?.workspaceId) return res.status(200).json(generic);
        const workspace = await db.orm.public.Workspace.where({ id: user.workspaceId }).first();
        if (!workspace?.emailVerificationHash) return res.status(200).json(generic);
        const token = crypto.randomBytes(32).toString("hex");
        await db.orm.public.Workspace.where({ id: workspace.id }).update({ emailVerificationHash: sha256(token), emailVerificationExpires: new Date(Date.now() + VERIFICATION_TTL_MS).toISOString() });
        await sendEmail({ to: email, subject: "Confirm your email address", html: verificationEmail(user.name, token, frontendBase(req)) }).catch((e) => console.error("resend verification email failed:", e.message));
        return res.status(200).json(generic);
    } catch (error) {
        console.error("resendVerification error:", error.message);
        return res.status(200).json(generic);
    }
};

// ── Login (+ 2FA) ───────────────────────────────────────────────────────────

const loginBlockedForWorkspace = async (user) => {
    if (!user.workspaceId) return user.role === "platform_admin" ? null : { message: "Workspace is not active", code: "workspace_inactive" };
    const workspace = await db.orm.public.Workspace.where({ id: user.workspaceId }).first();
    if (!workspace) return { message: "Workspace is not active", code: "workspace_inactive" };
    if (workspace.emailVerificationHash) return { message: "Please verify your email address first", code: "email_unverified" };
    if (workspace.status === "pending") return { message: "Your company is waiting for approval", code: "workspace_pending" };
    if (workspace.status !== "active") return { message: "Workspace is not active", code: "workspace_inactive" };
    return null;
};

export const companyLogin = async (req, res) => {
    try {
        const { email, password } = req.body ?? {};
        if (!email || !password) return res.status(400).json({ message: "Email and password are required", code: "validation_error" });
        const normalizedEmail = String(email).trim().toLowerCase();
        if (throttled(`${req.ip}|${normalizedEmail}`)) {
            return res.status(429).json({ message: "Too many login attempts. Try again in a few minutes.", code: "rate_limited" });
        }

        const user = await db.orm.public.User.where({ email: normalizedEmail }).first();
        if (!user) {
            await bcrypt.compare(String(password), "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva"); // equalise timing
            return res.status(401).json({ message: "Invalid email or password", code: "invalid_credentials" });
        }
        if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
            return res.status(423).json({ message: "Account temporarily locked after too many failed attempts. Try again later.", code: "account_locked" });
        }

        const ok = await bcrypt.compare(String(password), user.passwordHash);
        if (!ok) {
            const failed = (user.failedLoginCount || 0) + 1;
            const updates = { failedLoginCount: failed };
            if (failed >= MAX_FAILED_LOGINS) {
                updates.lockedUntil = new Date(Date.now() + LOCK_MS).toISOString();
                updates.failedLoginCount = 0;
            }
            await db.orm.public.User.where({ id: user.id }).update(updates);
            await audit({ workspaceId: user.workspaceId ?? null, actorType: "user", actorUserId: user.id, action: updates.lockedUntil ? "auth.account_locked" : "auth.login_failed", targetType: "user", targetId: user.id }, req);
            return res.status(401).json({ message: "Invalid email or password", code: "invalid_credentials" });
        }

        if (user.status !== "active") return res.status(403).json({ message: "Account is not active", code: "account_inactive" });
        const blocked = await loginBlockedForWorkspace(user);
        if (blocked) return res.status(403).json(blocked);

        await db.orm.public.User.where({ id: user.id }).update({ failedLoginCount: 0, lockedUntil: null });

        if (user.twoFactorEnabled && user.twoFactorSecretEnc) {
            const challengeToken = jwt.sign({ id: user.id, purpose: "2fa_login" }, ENV.JWT_SECRET, { expiresIn: CHALLENGE_TTL });
            return res.status(200).json({ message: "Enter the code from your authenticator app", twoFactorRequired: true, challengeToken });
        }

        genToken(user, res, { mfa: false });
        await db.orm.public.User.where({ id: user.id }).update({ lastLoginAt: new Date().toISOString() });
        await audit({ workspaceId: user.workspaceId ?? null, actorType: user.role === "platform_admin" ? "platform_admin" : "user", actorUserId: user.id, action: "auth.login", targetType: "user", targetId: user.id }, req);
        return res.status(200).json({
            message: "User verified",
            status: user.status,
            twoFactorSetupRequired: user.role === "platform_admin" && platformAdmin2faRequired(),
        });
    } catch (err) {
        console.error("login error:", err.message);
        return res.status(500).json({ message: "Internal server error from login controller", code: "internal_error" });
    }
};

/** POST /api/auth/2fa/verify { challengeToken, code } */
export const verifyTwoFactorLogin = async (req, res) => {
    try {
        const { challengeToken, code } = req.body ?? {};
        let decoded;
        try {
            decoded = jwt.verify(String(challengeToken ?? ""), ENV.JWT_SECRET);
            if (decoded.purpose !== "2fa_login") throw new Error("wrong purpose");
        } catch {
            return res.status(401).json({ message: "The login has expired. Sign in again.", code: "invalid_token" });
        }
        if (throttled(`2fa:${decoded.id}`)) return res.status(429).json({ message: "Too many attempts", code: "rate_limited" });
        const user = await db.orm.public.User.where({ id: decoded.id }).first();
        if (!user || user.status !== "active" || !user.twoFactorSecretEnc) return res.status(401).json({ message: "Invalid login", code: "unauthorized" });
        if (!verifyTotp(decryptSecret(user.twoFactorSecretEnc), code)) {
            await audit({ workspaceId: user.workspaceId ?? null, actorType: "user", actorUserId: user.id, action: "auth.2fa_failed", targetType: "user", targetId: user.id }, req);
            return res.status(401).json({ message: "That code is not valid", code: "invalid_code" });
        }
        const blocked = await loginBlockedForWorkspace(user);
        if (blocked) return res.status(403).json(blocked);
        genToken(user, res, { mfa: true });
        await db.orm.public.User.where({ id: user.id }).update({ lastLoginAt: new Date().toISOString() });
        await audit({ workspaceId: user.workspaceId ?? null, actorType: user.role === "platform_admin" ? "platform_admin" : "user", actorUserId: user.id, action: "auth.login", targetType: "user", targetId: user.id, metadata: { twoFactor: true } }, req);
        return res.status(200).json({ message: "User verified", status: user.status });
    } catch (error) {
        console.error("verifyTwoFactorLogin error:", error.message);
        return res.status(500).json({ message: "Internal server error", code: "internal_error" });
    }
};

/** POST /api/auth/2fa/setup — new secret (not active until confirmed with /2fa/enable). */
export const setupTwoFactor = async (req, res) => {
    try {
        const user = await db.orm.public.User.where({ id: req.user.id }).first();
        if (user.twoFactorEnabled) return res.status(409).json({ message: "Two-factor login is already on", code: "conflict" });
        const secret = generateSecret();
        await db.orm.public.User.where({ id: user.id }).update({ twoFactorSecretEnc: encryptSecret(secret) });
        return res.status(200).json({ secret, otpauthUrl: otpauthUrl(secret, user.email) });
    } catch (error) {
        console.error("setupTwoFactor error:", error.message);
        return res.status(500).json({ message: "Internal server error", code: "internal_error" });
    }
};

/** POST /api/auth/2fa/enable { code } */
export const enableTwoFactor = async (req, res) => {
    try {
        const user = await db.orm.public.User.where({ id: req.user.id }).first();
        if (!user.twoFactorSecretEnc) return res.status(400).json({ message: "Start the setup first", code: "validation_error" });
        if (!verifyTotp(decryptSecret(user.twoFactorSecretEnc), req.body?.code)) return res.status(400).json({ message: "That code is not valid", code: "invalid_code" });
        await db.orm.public.User.where({ id: user.id }).update({ twoFactorEnabled: true });
        await audit({ workspaceId: user.workspaceId ?? null, actorType: user.role === "platform_admin" ? "platform_admin" : "user", actorUserId: user.id, action: "auth.2fa_enabled", targetType: "user", targetId: user.id }, req);
        genToken(user, res, { mfa: true });
        return res.status(200).json({ message: "Two-factor login is on" });
    } catch (error) {
        console.error("enableTwoFactor error:", error.message);
        return res.status(500).json({ message: "Internal server error", code: "internal_error" });
    }
};

/** POST /api/auth/2fa/disable { code, password } — not allowed for platform admins while 2FA is required. */
export const disableTwoFactor = async (req, res) => {
    try {
        const user = await db.orm.public.User.where({ id: req.user.id }).first();
        if (user.role === "platform_admin" && platformAdmin2faRequired()) return res.status(403).json({ message: "Platform admins must keep two-factor login on", code: "forbidden" });
        if (!user.twoFactorEnabled) return res.status(400).json({ message: "Two-factor login is off", code: "validation_error" });
        const ok = (await bcrypt.compare(String(req.body?.password ?? ""), user.passwordHash)) && verifyTotp(decryptSecret(user.twoFactorSecretEnc), req.body?.code);
        if (!ok) return res.status(400).json({ message: "Password or code is not valid", code: "invalid_code" });
        await db.orm.public.User.where({ id: user.id }).update({ twoFactorEnabled: false, twoFactorSecretEnc: null });
        await audit({ workspaceId: user.workspaceId ?? null, actorType: "user", actorUserId: user.id, action: "auth.2fa_disabled", targetType: "user", targetId: user.id }, req);
        return res.status(200).json({ message: "Two-factor login is off" });
    } catch (error) {
        console.error("disableTwoFactor error:", error.message);
        return res.status(500).json({ message: "Internal server error", code: "internal_error" });
    }
};

/** GET /api/auth/me — the session plus current account/company state. */
export const sendMe = async (req, res) => {
    try {
        const token = req.cookies?.user_token;
        const decoded = token ? jwt.verify(token, ENV.JWT_SECRET) : null;
        let workspace = null;
        if (req.user.workspaceId) {
            const w = await db.orm.public.Workspace.where({ id: req.user.workspaceId }).first();
            workspace = w ? {
                id: w.id,
                name: w.name,
                status: w.status,
                timezone: w.timezone,
                reportingCurrency: w.reportingCurrency,
                defaultModel: w.defaultModel,
                weekStart: w.weekStart,
                plan: w.plan || "free",
                subscriptionStatus: w.subscriptionStatus || "active",
                billingInterval: w.billingInterval || null,
                trialEndsAt: w.trialEndsAt || null,
                currentPeriodEndsAt: w.currentPeriodEndsAt || null,
                cancelAtPeriodEnd: Boolean(w.cancelAtPeriodEnd),
            } : null;
        }
        return res.status(200).json({
            message: "Token decoded",
            decoded: { ...decoded, twoFactorEnabled: req.user.twoFactorEnabled, mfaPending: req.user.mfaPending, allowedLocationIds: req.user.allowedLocationIds },
            workspace,
        });
    } catch (error) {
        return res.status(500).json({ message: "Internal server error while reading the session", code: "internal_error" });
    }
};

// ── Password reset ──────────────────────────────────────────────────────────

/** POST /api/auth/user/forgotpass { email } — same answer whether or not the account exists. */
export const forgotPass = async (req, res) => {
    const generic = { message: "If an account exists for that email, password reset instructions are on their way." };
    try {
        const email = String(req.body?.email ?? "").trim().toLowerCase();
        if (!email) return res.status(400).json({ message: "Email is required", code: "validation_error" });
        if (throttled(`reset:${email}`)) return res.status(200).json(generic);
        const user = await db.orm.public.User.where({ email }).first();
        if (!user || user.status !== "active") return res.status(200).json(generic);

        // tied to the current password hash, so it stops working once used
        const resetToken = jwt.sign({ userId: user.id, type: "password_reset" }, ENV.JWT_SECRET + user.passwordHash, { expiresIn: "1h" });
        const resetUrl = `${frontendBase(req)}/reset-password?token=${resetToken}`;
        let html;
        try {
            html = fs.readFileSync(path.join(process.cwd(), "templates", "passwordReset.html"), "utf-8").replace(/\{\{name\}\}/g, escapeHtml(user.name || "there")).replace(/\{\{resetUrl\}\}/g, resetUrl);
        } catch {
            html = `<p>Hi ${escapeHtml(user.name)},</p><p>Reset your password: <a href="${resetUrl}">${resetUrl}</a></p>`;
        }
        await sendEmail({ to: email, subject: "Reset your password", html }).catch((e) => console.error("password reset email failed:", e.message));
        return res.status(200).json(generic);
    } catch (error) {
        console.error("forgotPass error:", error.message);
        return res.status(200).json(generic);
    }
};

/** POST /api/auth/user/reset-password { token, newPassword } */
export const resetPassword = async (req, res) => {
    try {
        const { token, newPassword } = req.body ?? {};
        if (!token) return res.status(400).json({ message: "Reset token is required", code: "validation_error" });
        const decoded = jwt.decode(String(token));
        if (!decoded?.userId || decoded.type !== "password_reset") return res.status(400).json({ message: "Invalid reset token", code: "invalid_token" });
        const user = await db.orm.public.User.where({ id: decoded.userId }).first();
        if (!user) return res.status(400).json({ message: "Invalid or expired reset token", code: "invalid_token" });
        try {
            jwt.verify(String(token), ENV.JWT_SECRET + user.passwordHash);
        } catch {
            return res.status(400).json({ message: "Reset token has expired or is invalid", code: "invalid_token" });
        }
        const problem = passwordProblem(newPassword, user.email);
        if (problem) return res.status(400).json({ message: problem, code: "weak_password" });

        await db.orm.public.User.where({ id: user.id }).update({
            passwordHash: await bcrypt.hash(newPassword, 10),
            passwordChangedAt: new Date().toISOString(),
            failedLoginCount: 0,
            lockedUntil: null,
        });
        await audit({ workspaceId: user.workspaceId ?? null, actorType: "user", actorUserId: user.id, action: "auth.password_reset", targetType: "user", targetId: user.id }, req);
        return res.status(200).json({ message: "Password has been reset. You can now log in with your new password." });
    } catch (error) {
        console.error("resetPassword error:", error.message);
        return res.status(500).json({ message: "Internal server error while resetting password", code: "internal_error" });
    }
};

export const userLogout = async (req, res) => {
    try {
        res.clearCookie("user_token", { httpOnly: true, secure: true, sameSite: "none", path: "/" });
        return res.status(200).json({ message: "Logged out successfully" });
    } catch (error) {
        console.error("Logout error:", error.message);
        return res.status(500).json({ message: "Internal server error during logout", code: "internal_error" });
    }
};
