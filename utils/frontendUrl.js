/**
 * Where the dashboard lives, for links in emails and redirects.
 *
 * Links follow the dashboard the person is actually using: when the request comes from an allowed
 * dashboard origin (the browser's Origin header), links point there. Otherwise FRONTEND_URL is used.
 * So an invite sent from https://app.example.com links to https://app.example.com/accept-invite even if
 * FRONTEND_URL is missing or points to an old deployment. Only allowed origins are used, so a forged
 * Origin header can never put a foreign domain into an email.
 */
import ENV from "./env.js";

const trim = (u) => String(u).trim().replace(/\/+$/, "");

/** Dashboard origins allowed for the cookie session. Keep in step with allowedOrigins in server.js. */
export function allowedDashboardOrigins() {
    return [
        ENV.FRONTEND_URL,
        ...(process.env.EXTRA_CORS_ORIGINS ? process.env.EXTRA_CORS_ORIGINS.split(",").map(trim).filter(Boolean) : []),
        "https://asf-tas.vercel.app",
        "https://asftas.vercel.app",
        "http://localhost:5173", // also allowed by CORS in server.js
        ...(ENV.NODE_ENV === "production" ? [] : ["http://localhost:3000", "http://localhost:5173", "http://localhost:5175"]),
    ].map(trim);
}

/** Base URL for links in emails sent during this request. */
export function frontendBase(req) {
    const candidates = [req?.headers?.origin, req?.headers?.referer].filter(Boolean);
    const allowed = new Set(allowedDashboardOrigins());
    for (const c of candidates) {
        try {
            const origin = new URL(String(c)).origin;
            if (allowed.has(origin)) return origin;
        } catch {
            /* not a URL */
        }
    }
    return trim(ENV.FRONTEND_URL);
}

/** Validate a stored return origin (e.g. carried through an OAuth state). */
export function safeFrontendOrigin(origin) {
    if (!origin) return trim(ENV.FRONTEND_URL);
    return new Set(allowedDashboardOrigins()).has(trim(origin)) ? trim(origin) : trim(ENV.FRONTEND_URL);
}
