import jwt from 'jsonwebtoken'
import ENV from '../utils/env.js'

/** Session lifetimes (scope 4.10 "session expiry"): platform admins get short sessions. */
export const SESSION_TTL = {
    platform_admin: 12 * 60 * 60, // 12 hours
    default: 7 * 24 * 60 * 60, // 7 days
};

/**
 * Issue the session cookie.
 * @param {object} user
 * @param {object} res
 * @param {{ mfa?: boolean }} opts  mfa: the user completed a two-factor check in this login
 */
export const genToken = (user, res, { mfa = false } = {}) => {
    const ttl = user.role === "platform_admin" ? SESSION_TTL.platform_admin : SESSION_TTL.default;
    const payload = {
        id: user.id,
        role: user.role,
        name: user.name,
        email: user.email,
        status: user.status,
        workspaceId: user.workspaceId ?? null,
        mfa: Boolean(mfa),
    };
    const token = jwt.sign(payload, ENV.JWT_SECRET, { expiresIn: ttl });
    res.cookie("user_token", token, {
        secure: true,
        httpOnly: true,
        sameSite: 'none',
        maxAge: ttl * 1000,
    });
    return token;
}

export default genToken;
