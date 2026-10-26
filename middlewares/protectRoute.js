import jwt from "jsonwebtoken";
import ENV from "../utils/env.js";
import { db } from "../src/prisma/db.js";

/** Platform admins must use two-factor login (scope 4.9). Set REQUIRE_PLATFORM_ADMIN_2FA=false only for local development. */
export const platformAdmin2faRequired = () => String(process.env.REQUIRE_PLATFORM_ADMIN_2FA ?? "true").toLowerCase() !== "false";

// While a platform admin has not completed 2FA, only these routes work (to enrol or to log out).
const MFA_SETUP_PATHS = ["/api/auth/me", "/api/auth/2fa/setup", "/api/auth/2fa/enable", "/api/auth/logout"];

export const protectRoute = async (req, res, next) => {
  try {
    const token = req.cookies?.user_token;
    if (!token) return res.status(401).json({ message: "Not logged in", code: "unauthorized" });
    let decoded;
    try {
      decoded = jwt.verify(token, ENV.JWT_SECRET);
    } catch (err) {
      const message = err.name === "TokenExpiredError" ? "Session expired" : "Invalid token";
      return res.status(401).json({ message, code: "unauthorized" });
    }
    const user = await db.orm.public.User.where({ id: decoded.id }).first();
    if (!user) return res.status(401).json({ message: "User no longer exists", code: "unauthorized" });
    if (user.status !== "active") return res.status(403).json({ message: "Account is not active", code: "account_inactive" });

    // A password change ends every older session.
    if (user.passwordChangedAt && decoded.iat && decoded.iat * 1000 < new Date(user.passwordChangedAt).getTime() - 1000) {
      return res.status(401).json({ message: "Session expired", code: "unauthorized" });
    }

    // Recheck workspace state for every request so existing cookies stop
    // working immediately if the workspace is suspended, closed, pending or unverified.
    if (user.workspaceId) {
      const workspace = await db.orm.public.Workspace.where({ id: user.workspaceId }).first();
      if (!workspace) return res.status(403).json({ message: "Workspace is not active", code: "workspace_inactive" });
      if (workspace.emailVerificationHash) return res.status(403).json({ message: "Please verify your email address first", code: "email_unverified" });
      if (workspace.status === "pending") return res.status(403).json({ message: "Your company is waiting for approval", code: "workspace_pending" });
      if (workspace.status !== "active") return res.status(403).json({ message: "Workspace is not active", code: "workspace_inactive" });
    } else if (user.role !== "platform_admin") {
      return res.status(403).json({ message: "Workspace is not active", code: "workspace_inactive" });
    }

    const path = String(req.originalUrl ?? "").split("?")[0];
    const mfaPending = user.role === "platform_admin" && platformAdmin2faRequired() && !decoded.mfa;
    if (mfaPending && !MFA_SETUP_PATHS.includes(path)) {
      return res.status(403).json({
        message: user.twoFactorEnabled ? "Two-factor verification is required" : "Set up two-factor login to continue",
        code: user.twoFactorEnabled ? "mfa_required" : "mfa_setup_required",
      });
    }

    // Users limited to certain locations (company viewers with location access) only see those.
    let allowedLocationIds = [];
    if (user.workspaceId && user.role === "company_viewer") {
      try {
        allowedLocationIds = (await db.orm.public.UserLocationAccess.where({ userId: user.id }).all()).map((a) => a.locationId);
      } catch {
        allowedLocationIds = [];
      }
    }

    req.user = {
      id: user.id,
      role: user.role,
      workspaceId: user.workspaceId ?? null,
      name: user.name,
      email: user.email,
      twoFactorEnabled: Boolean(user.twoFactorEnabled),
      mfa: Boolean(decoded.mfa),
      mfaPending,
      allowedLocationIds,
    };
    req.workspaceId = user.workspaceId ?? null;
    return next();
  } catch (error) {
    console.error("protectRoute error:", error.message);
    return res.status(500).json({ message: "Internal server error in auth check", code: "internal_error" });
  }
};

export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Not logged in", code: "unauthorized" });
    if (!roles.includes(req.user.role))
      return res.status(403).json({ message: "You do not have permission for this action", code: "forbidden" });
    return next();
  };

export default protectRoute;
