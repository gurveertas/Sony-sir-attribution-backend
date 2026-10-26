// middleware/apiKeyAuth.js
//
// Protects the public /v1 routes with an API key (instead of a login cookie).
//   1. Reads the key from "Authorization: Bearer <key>" (or "X-Api-Key").
//   2. Hashes it and looks the hash up, so the real key is never stored.
//   3. Rejects revoked / expired keys, wrong key types, and origins not on the allowed list.
//   4. Sets req.workspaceId and req.apiKey. The workspace comes ONLY from the key.

import crypto from "crypto";
import { db } from "../src/prisma/db.js";
import { rateLimiter } from "./rateLimiter.js";

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const LAST_USED_INTERVAL_MS = 60_000; // don't write lastUsedAt on every request

// The SDK calls on every page view: cache key lookups briefly (a revoke takes effect within 30 s).
const KEY_CACHE_MS = 30_000;
const keyCache = new Map();
async function keyByHash(hash) {
    const hit = keyCache.get(hash);
    if (hit && Date.now() - hit.at < KEY_CACHE_MS) return hit.key;
    const key = await db.orm.public.ApiKey.where({ keyHash: hash }).first();
    keyCache.set(hash, { at: Date.now(), key });
    if (keyCache.size > 5000) keyCache.delete(keyCache.keys().next().value);
    return key;
}
export const clearKeyCache = () => keyCache.clear();

// CORS for /v1. Mount this BEFORE apiKeyAuth, and before any global cors() in app.js.
// Browsers send an OPTIONS "preflight" with no key, so it can't be checked here. It is
// answered openly, and the real request is checked against the key's allowed origins.
export function v1Cors(req, res, next) {
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, Idempotency-Key, Prefer");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
        res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    return next();
}

// allowedTypes: which key types may call the route. Tracking routes accept publishable keys.
export const apiKeyAuth =
    (allowedTypes = ["publishable"]) =>
    async (req, res, next) => {
        try {
            const header = req.headers.authorization || "";
            const raw = (header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-api-key"] || "")
                .toString()
                .trim();
            if (!raw || raw.length > 200) return res.status(401).json({ message: "API key required" });

            const key = await keyByHash(sha256(raw));
            if (!key || key.revokedAt || (key.expiresAt && new Date(key.expiresAt) < new Date())) {
                return res.status(401).json({ message: "Invalid API key" });
            }
            if (!allowedTypes.includes(key.type)) {
                return res.status(403).json({ message: "This key type cannot call this route" });
            }

            // Publishable keys are public, so they only work from the listed websites.
            if (key.type === "publishable") {
                const origin = (req.headers.origin || "").toLowerCase();
                if (origin) {
                    if (!key.allowedOrigins.includes(origin)) {
                        return res.status(403).json({ message: "Origin not allowed for this key" });
                    }
                } else if (key.mode !== "test") {
                    // No Origin header means it is not a browser. Only test keys may do that (curl, Postman).
                    return res.status(403).json({ message: "Origin header required" });
                }
            }

            // Suspended / closed companies lose API access immediately (same rule protectRoute applies to logins)
            const workspace = await db.orm.public.Workspace.where({ id: key.workspaceId }).first();
            if (!workspace || workspace.status !== "active") {
                return res.status(403).json({ message: "Workspace is not active" });
            }

            // Live keys stay inactive until a domain is verified (scope 4.1). Test (sandbox) keys work
            // straight away so the setup checklist and test-event tool can be used before going live.
            if (key.mode === "live") {
                const sites = (await db.orm.public.Site.where({ workspaceId: key.workspaceId }).all()).filter((s) => s.verifiedAt);
                if (key.siteId && !sites.some((s) => s.id === key.siteId)) {
                    return res.status(403).json({ message: "Site is not verified yet", code: "site_unverified" });
                }
                if (!sites.length) return res.status(403).json({ message: "Verify your domain before using live keys", code: "site_unverified" });
                if (key.type === "publishable" && req.headers.origin) {
                    const host = (() => {
                        try {
                            return new URL(req.headers.origin).hostname.toLowerCase();
                        } catch {
                            return "";
                        }
                    })();
                    const verifiedHost = sites.some((s) => {
                        const d = String(s.domain).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
                        return host === d || host.endsWith(`.${d}`);
                    });
                    if (!verifiedHost) return res.status(403).json({ message: "This origin is not a verified domain of the company", code: "origin_unverified" });
                }
            }

            req.workspaceId = key.workspaceId; // the ONLY source of the workspace on /v1 routes
            req.apiKey = {
                id: key.id,
                type: key.type,
                mode: key.mode,
                siteId: key.siteId ?? null,
                rateLimitPerMin: key.rateLimitPerMin || 60,
            };

            const last = key.lastUsedAt ? new Date(key.lastUsedAt).getTime() : 0;
            if (Date.now() - last > LAST_USED_INTERVAL_MS) {
                void (async () => {
                    try {
                        await db.orm.public.ApiKey.where({ id: key.id }).update({
                            lastUsedAt: new Date().toISOString(),
                        });
                    } catch {
                        /* not worth failing a request over */
                    }
                })();
            }

            return rateLimiter(req, res, next);
        } catch (error) {
            console.error("apiKeyAuth error:", error.message);
            return res.status(500).json({ message: "Internal server error in key check" });
        }
    };