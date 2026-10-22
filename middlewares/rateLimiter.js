/**
 * In-Memory Rate Limiter for API Key authenticated routes (/v1/*)
 *
 * Uses the API key's `rateLimitPerMin` setting (stored on the key record).
 * Falls back to a default of 60 req/min for unknown keys.
 *
 * Strategy: sliding window counter per API key ID.
 * Memory is cleaned up every 5 minutes to prevent unbounded growth.
 *
 * For production scale, swap this with a Redis-based limiter.
 */

const DEFAULT_RATE_LIMIT = 60;
const WINDOW_MS = 60_000; // 1 minute
const CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes

// Map<apiKeyId, { count, windowStart }>
const windows = new Map();

// Periodic cleanup of stale entries
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of windows) {
        if (now - entry.windowStart > WINDOW_MS * 2) {
            windows.delete(key);
        }
    }
}, CLEANUP_INTERVAL_MS).unref(); // .unref() so it doesn't prevent process exit

/**
 * Express middleware — must be mounted AFTER apiKeyAuth so req.apiKey is set.
 */
export function rateLimiter(req, res, next) {
    const apiKey = req.apiKey;
    if (!apiKey?.id) return next(); // no API key context — skip (shouldn't happen on /v1)

    const limit = apiKey.rateLimitPerMin || DEFAULT_RATE_LIMIT;
    const keyId = apiKey.id;
    const now = Date.now();

    let entry = windows.get(keyId);

    if (!entry || now - entry.windowStart > WINDOW_MS) {
        // Start a new window
        entry = { count: 1, windowStart: now };
        windows.set(keyId, entry);
    } else {
        entry.count++;
    }

    // Set standard rate-limit headers
    const remaining = Math.max(0, limit - entry.count);
    const resetAt = Math.ceil((entry.windowStart + WINDOW_MS) / 1000);

    res.setHeader("X-RateLimit-Limit", limit);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetAt);

    if (entry.count > limit) {
        const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
        res.setHeader("Retry-After", retryAfter);
        return res.status(429).json({
            message: "Rate limit exceeded. Try again later.",
            retryAfterSeconds: retryAfter,
        });
    }

    return next();
}
