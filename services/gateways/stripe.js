/**
 * Stripe adapter — creates / removes the webhook endpoint through the Stripe API.
 *
 * The user's API key is used only for the calls made during connect / disconnect.
 * It is NOT persisted: only the webhook signing secret returned by Stripe is stored.
 */

import { GatewayError, ValidationError, classifyStatus, requestJson } from "./http.js";

const PROVIDER = "Stripe";
const API = "https://api.stripe.com/v1";

/** Events the platform needs. Keep in sync with processStripe() in connectorProcessors.js. */
export const STRIPE_EVENTS = [
    "payment_intent.succeeded",
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "charge.refunded",
    "charge.refund.updated",
];

const KEY_PATTERN = /^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/;

export function parseSecretKey(value) {
    if (typeof value !== "string" || !KEY_PATTERN.test(value.trim())) {
        throw new ValidationError(
            "A Stripe secret key (sk_live_/sk_test_) or restricted key (rk_live_/rk_test_) is required",
        );
    }
    return value.trim();
}

export function keyEnvironment(secretKey) {
    return secretKey.includes("_live_") ? "live" : "test";
}

const authHeaders = (secretKey) => ({ Authorization: `Bearer ${secretKey}` });

function toGatewayError(response, fallback) {
    const kind = classifyStatus(response.status);
    const stripeMessage = response.data?.error?.message;
    if (kind === "invalid_credentials") {
        return new GatewayError(
            PROVIDER,
            kind,
            response.status === 403
                ? "Stripe rejected this key. A restricted key needs Write access to 'Webhook Endpoints'."
                : "Stripe rejected this API key. Check that it is correct and has not been revoked.",
            { status: response.status, code: response.data?.error?.code ?? null },
        );
    }
    return new GatewayError(PROVIDER, kind, stripeMessage || fallback, {
        status: response.status,
        code: response.data?.error?.code ?? null,
    });
}

/**
 * Validates the key and, when the key is allowed to, reads the account identity.
 * Restricted keys often cannot read /v1/account, so a 403 here is not fatal.
 */
export async function verifyCredentials(secretKey) {
    const response = await requestJson(PROVIDER, `${API}/account`, { headers: authHeaders(secretKey) });
    if (response.ok) {
        const account = response.data ?? {};
        return {
            accountId: account.id ?? null,
            businessName:
                account.settings?.dashboard?.display_name || account.business_profile?.name || null,
        };
    }
    if (response.status === 403) return { accountId: null, businessName: null };
    throw toGatewayError(response, "Could not verify the Stripe key");
}

export async function createWebhook({ secretKey, url, events = STRIPE_EVENTS, description, idempotencyKey }) {
    const body = new URLSearchParams();
    body.append("url", url);
    for (const event of events) body.append("enabled_events[]", event);
    if (description) body.append("description", description);

    const response = await requestJson(PROVIDER, `${API}/webhook_endpoints`, {
        method: "POST",
        headers: {
            ...authHeaders(secretKey),
            "Content-Type": "application/x-www-form-urlencoded",
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: body.toString(),
    });

    if (!response.ok) throw toGatewayError(response, "Stripe could not create the webhook endpoint");
    if (!response.data?.id || !response.data?.secret) {
        throw new GatewayError(PROVIDER, "rejected", "Stripe did not return a webhook signing secret");
    }
    return { id: response.data.id, secret: response.data.secret, status: response.data.status ?? null };
}

export async function getWebhook({ secretKey, id }) {
    const response = await requestJson(PROVIDER, `${API}/webhook_endpoints/${encodeURIComponent(id)}`, {
        headers: authHeaders(secretKey),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw toGatewayError(response, "Could not read the Stripe webhook endpoint");
    return {
        id: response.data.id,
        url: response.data.url,
        status: response.data.status,
        enabledEvents: response.data.enabled_events ?? [],
    };
}

/** @returns {{deleted: boolean, alreadyGone: boolean}} */
export async function deleteWebhook({ secretKey, id }) {
    const response = await requestJson(PROVIDER, `${API}/webhook_endpoints/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: authHeaders(secretKey),
    });
    if (response.status === 404) return { deleted: false, alreadyGone: true };
    if (!response.ok) throw toGatewayError(response, "Stripe could not delete the webhook endpoint");
    return { deleted: true, alreadyGone: false };
}
