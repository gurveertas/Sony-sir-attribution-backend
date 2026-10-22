/**
 * PayPal adapter — creates / removes the webhook through the PayPal Notifications API
 * and provides the OAuth token helper used for webhook signature verification.
 *
 * PayPal needs the client credentials again for every incoming-event verification,
 * so (unlike Stripe) they are stored — encrypted — by the caller.
 */

import { GatewayError, ValidationError, classifyStatus, requestJson } from "./http.js";

const PROVIDER = "PayPal";

/** Events the platform needs. Keep in sync with processPayPal() in connectorProcessors.js. */
export const PAYPAL_EVENTS = ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED"];

export function apiBase(environment) {
    return environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

export function parseCredentials(input = {}) {
    const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
    const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
    const environment = input.environment ?? input.paypalEnvironment ?? "sandbox";

    if (!clientId || !clientSecret) throw new ValidationError("PayPal clientId and clientSecret are required");
    if (clientId.length > 200 || clientSecret.length > 200) throw new ValidationError("PayPal credentials are too long");
    if (!["sandbox", "live"].includes(environment)) {
        throw new ValidationError("environment must be 'sandbox' or 'live'");
    }
    return { clientId, clientSecret, environment };
}

// ── OAuth token (cached in memory until shortly before expiry) ──────────────

const tokenCache = new Map();
const TOKEN_SAFETY_MS = 60_000;

export function clearTokenCache() {
    tokenCache.clear();
}

export async function getAccessToken({ clientId, clientSecret, environment }, { forceRefresh = false } = {}) {
    const cacheKey = `${environment}:${clientId}`;
    const cached = tokenCache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt - TOKEN_SAFETY_MS > Date.now()) return cached.token;

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await requestJson(PROVIDER, `${apiBase(environment)}/v1/oauth2/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
    });

    if (!response.ok || !response.data?.access_token) {
        if (response.status === 401 || response.status === 400 || response.status === 403) {
            throw new GatewayError(
                PROVIDER,
                "invalid_credentials",
                `PayPal rejected these credentials. Check the client ID/secret and that they belong to the ${environment} environment.`,
                { status: response.status },
            );
        }
        throw new GatewayError(PROVIDER, classifyStatus(response.status), "PayPal could not issue an access token", {
            status: response.status,
        });
    }

    const ttlMs = (Number(response.data.expires_in) || 300) * 1000;
    tokenCache.set(cacheKey, { token: response.data.access_token, expiresAt: Date.now() + ttlMs });
    return response.data.access_token;
}

const bearer = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

function toGatewayError(response, fallback) {
    const kind = classifyStatus(response.status);
    if (kind === "invalid_credentials") {
        return new GatewayError(PROVIDER, kind, "PayPal rejected the request. The app may lack webhook permissions.", {
            status: response.status,
        });
    }
    return new GatewayError(PROVIDER, kind, response.data?.message || fallback, {
        status: response.status,
        code: response.data?.name ?? null,
    });
}

export async function listWebhooks(creds) {
    const token = await getAccessToken(creds);
    const response = await requestJson(PROVIDER, `${apiBase(creds.environment)}/v1/notifications/webhooks`, {
        headers: bearer(token),
    });
    if (!response.ok) throw toGatewayError(response, "Could not list PayPal webhooks");
    return response.data?.webhooks ?? [];
}

/**
 * Creates the webhook. If PayPal says the URL is already registered for this app,
 * the existing webhook is reused instead of failing (makes connect safely re-runnable).
 * @returns {{id: string, reused: boolean}}
 */
export async function createWebhook({ creds, url, events = PAYPAL_EVENTS }) {
    const token = await getAccessToken(creds);
    const response = await requestJson(PROVIDER, `${apiBase(creds.environment)}/v1/notifications/webhooks`, {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ url, event_types: events.map((name) => ({ name })) }),
    });

    if (response.ok && response.data?.id) return { id: response.data.id, reused: false };

    if (response.data?.name === "WEBHOOK_URL_ALREADY_EXISTS") {
        const existing = (await listWebhooks(creds)).find((hook) => hook.url === url);
        if (existing?.id) return { id: existing.id, reused: true };
    }
    throw toGatewayError(response, "PayPal could not create the webhook");
}

export async function getWebhook({ creds, id }) {
    const token = await getAccessToken(creds);
    const response = await requestJson(
        PROVIDER,
        `${apiBase(creds.environment)}/v1/notifications/webhooks/${encodeURIComponent(id)}`,
        { headers: bearer(token) },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw toGatewayError(response, "Could not read the PayPal webhook");
    return {
        id: response.data.id,
        url: response.data.url,
        eventTypes: (response.data.event_types ?? []).map((event) => event.name),
    };
}

/** @returns {{deleted: boolean, alreadyGone: boolean}} */
export async function deleteWebhook({ creds, id }) {
    const token = await getAccessToken(creds);
    const response = await requestJson(
        PROVIDER,
        `${apiBase(creds.environment)}/v1/notifications/webhooks/${encodeURIComponent(id)}`,
        { method: "DELETE", headers: bearer(token) },
    );
    if (response.status === 404) return { deleted: false, alreadyGone: true };
    if (!response.ok) throw toGatewayError(response, "PayPal could not delete the webhook");
    return { deleted: true, alreadyGone: false };
}

/** Server-side verification of an incoming webhook event (PayPal's verify-webhook-signature API). */
export async function verifyWebhookSignature({ creds, webhookId, headers, event }) {
    const transmission = {
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
    };
    if (Object.values(transmission).some((value) => !value)) {
        throw new GatewayError(PROVIDER, "rejected", "PayPal webhook is missing required signature headers");
    }

    const send = async (token) =>
        requestJson(PROVIDER, `${apiBase(creds.environment)}/v1/notifications/verify-webhook-signature`, {
            method: "POST",
            headers: bearer(token),
            body: JSON.stringify(transmission),
        });

    let response = await send(await getAccessToken(creds));
    if (response.status === 401) {
        // cached token may have been revoked — retry once with a fresh one
        response = await send(await getAccessToken(creds, { forceRefresh: true }));
    }
    if (!response.ok) {
        throw new GatewayError(PROVIDER, classifyStatus(response.status), `PayPal webhook verification failed (${response.status})`, {
            status: response.status,
        });
    }
    return response.data?.verification_status === "SUCCESS";
}
