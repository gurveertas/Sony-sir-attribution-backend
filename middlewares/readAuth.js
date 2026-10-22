/**
 * Authentication for READ endpoints (orders, customers, bookings, reports).
 *
 *   - Dashboard users: the session cookie (+ role check), exactly as before.
 *   - Machine clients: a SECRET API key via "Authorization: Bearer <key>" or "X-Api-Key".
 *     Publishable keys are public (they sit in page source) and are never accepted for reads.
 *
 * The workspace always comes from the key or the login, never from the request.
 */

import { apiKeyAuth } from "./apiKeyAuth.js";
import { protectRoute, requireRole } from "./protectRoute.js";

const secretKeyOnly = apiKeyAuth(["secret"]);

const presentsApiKey = (req) =>
    String(req.headers.authorization ?? "").startsWith("Bearer ") || Boolean(req.headers["x-api-key"]);

export const readAccess = (...roles) => [
    (req, res, next) => (presentsApiKey(req) ? secretKeyOnly(req, res, next) : protectRoute(req, res, next)),
    (req, res, next) => (req.apiKey ? next() : requireRole(...roles)(req, res, next)),
];
