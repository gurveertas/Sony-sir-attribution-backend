/**
 * Minimal HTTP helper for calling payment-gateway APIs.
 *
 * - Hard timeout on every request (connection + body).
 * - Never throws raw network errors: callers always get a GatewayError
 *   whose message is safe to show to an end user (no credentials, no URLs with secrets).
 */

export class GatewayError extends Error {
    /**
     * @param {string} provider  "Stripe" | "PayPal" | "Razorpay"
     * @param {"invalid_credentials"|"unavailable"|"rejected"|"not_found"} kind
     */
    constructor(provider, kind, message, { status = null, code = null } = {}) {
        super(message);
        this.name = "GatewayError";
        this.provider = provider;
        this.kind = kind;
        this.status = status;
        this.code = code;
    }
}

export class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "ValidationError";
    }
}

export function classifyStatus(status) {
    if (status === 401 || status === 403) return "invalid_credentials";
    if (status === 404) return "not_found";
    if (status === 408 || status === 429 || status >= 500) return "unavailable";
    return "rejected";
}

export async function requestJson(provider, url, { method = "GET", headers = {}, body, timeoutMs = 10_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let response;
        let text;
        try {
            response = await fetch(url, { method, headers, body, signal: controller.signal });
            text = await response.text();
        } catch (err) {
            const timedOut = err?.name === "AbortError";
            throw new GatewayError(
                provider,
                "unavailable",
                timedOut ? `${provider} did not respond in time` : `Could not reach ${provider}`,
            );
        }

        let data = null;
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = { raw: text.slice(0, 200) };
            }
        }
        return { status: response.status, ok: response.ok, data };
    } finally {
        clearTimeout(timer);
    }
}
