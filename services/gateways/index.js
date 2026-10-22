/**
 * Gateway registry: one driver per payment gateway with a uniform interface used by
 * gatewayConnectController.js.
 *
 * Driver interface
 *   mode                       "auto" (we create the webhook) | "manual" (merchant pastes it)
 *   parseCredentials(input)    -> normalized credentials; throws ValidationError
 *   connect(ctx)               -> { publicConfig, secrets, fingerprint, remoteRef, reveal }
 *   removeRemote(ctx)          -> { removed, reason? }          (throws GatewayError on hard failure)
 *   verify(ctx)                -> [{ name, ok, detail }]
 */

import crypto from "crypto";
import ENV from "../../utils/env.js";
import { GatewayError, ValidationError } from "./http.js";
import * as stripe from "./stripe.js";
import * as paypal from "./paypal.js";
import * as razorpay from "./razorpay.js";

export { GatewayError, ValidationError };

export const GATEWAY_TYPES = ["stripe", "paypal", "razorpay"];
export const isGatewayType = (type) => GATEWAY_TYPES.includes(type);

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

// ── Webhook URL ──────────────────────────────────────────────────────────────

const LEGACY_FALLBACK_BASE = "https://asbtemp-production.up.railway.app";

export function getPublicApiBase() {
    return ENV.APP_API_URL || process.env.APP_API_URL || LEGACY_FALLBACK_BASE;
}

/** Path-style URL (works for gateways that dislike query strings). Query-style URLs still work too. */
export function buildWebhookUrl(type, connectorId) {
    return `${getPublicApiBase()}/api/connectors/${type}/webhook/${connectorId}`;
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.)/i;

/** Gateways must be able to reach the URL from the internet. */
export function assertPublicHttpsUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new ValidationError("APP_API_URL is not a valid URL");
    }
    if (parsed.protocol !== "https:") {
        throw new ValidationError("APP_API_URL must be an https:// URL — payment gateways only deliver webhooks over HTTPS");
    }
    if (PRIVATE_HOST.test(parsed.hostname) || parsed.hostname === "[::1]") {
        throw new ValidationError("APP_API_URL must be publicly reachable (not localhost or a private address). Use a tunnel such as ngrok for local testing.");
    }
}

// ── Drivers ──────────────────────────────────────────────────────────────────

const firstEventCheck = (connector) => ({
    name: "first_event_received",
    ok: Boolean(connector?.lastEventAt),
    detail: connector?.lastEventAt
        ? `Last event at ${connector.lastEventAt}`
        : "No event received yet. Make a test payment or send a test event from the gateway dashboard.",
});

const secretCheck = (ok) => ({
    name: "signing_secret_stored",
    ok,
    detail: ok ? "A signing secret is stored" : "No signing secret stored — reconnect this connector",
});

const stripeDriver = {
    mode: "auto",
    events: stripe.STRIPE_EVENTS,

    parseCredentials(input = {}) {
        return { secretKey: stripe.parseSecretKey(input.secretKey) };
    },

    async connect({ creds, webhookUrl, connectorId, name, attempt = "c" }) {
        const environment = stripe.keyEnvironment(creds.secretKey);
        const identity = await stripe.verifyCredentials(creds.secretKey);
        const endpoint = await stripe.createWebhook({
            secretKey: creds.secretKey,
            url: webhookUrl,
            events: stripe.STRIPE_EVENTS,
            description: `Attribution platform — ${name}`.slice(0, 200),
            idempotencyKey: `attr-${connectorId}-${attempt}`,
        });
        return {
            publicConfig: {
                gateway: "stripe",
                connectionMode: "auto",
                environment,
                stripeAccountId: identity.accountId,
                businessName: identity.businessName,
                webhookEndpointId: endpoint.id,
                enabledEvents: stripe.STRIPE_EVENTS,
            },
            secrets: { webhookSecret: endpoint.secret },
            // fall back to the endpoint-less identity only when Stripe will tell us the account
            fingerprint: identity.accountId ? sha256(identity.accountId) : null,
            remoteRef: { id: endpoint.id },
            reveal: null,
        };
    },

    async removeRemote({ config, creds, remoteId }) {
        const id = remoteId ?? config.webhookEndpointId;
        if (!id) return { removed: false, reason: "no_remote_webhook" };
        if (!creds?.secretKey) return { removed: false, reason: "credentials_not_provided" };
        const result = await stripe.deleteWebhook({ secretKey: creds.secretKey, id });
        return { removed: result.deleted, reason: result.alreadyGone ? "already_removed" : undefined };
    },

    async verify({ connector, config, creds }) {
        const checks = [secretCheck(Boolean(config.webhookSecret)), firstEventCheck(connector)];
        if (creds?.secretKey && config.webhookEndpointId) {
            const hook = await stripe.getWebhook({ secretKey: creds.secretKey, id: config.webhookEndpointId });
            checks.push({
                name: "remote_webhook_active",
                ok: Boolean(hook && hook.status === "enabled"),
                detail: hook ? `Stripe endpoint is ${hook.status}` : "The webhook endpoint no longer exists in Stripe",
            });
            if (hook) {
                const missing = stripe.STRIPE_EVENTS.filter((event) => !hook.enabledEvents.includes(event) && !hook.enabledEvents.includes("*"));
                checks.push({
                    name: "remote_events_subscribed",
                    ok: missing.length === 0,
                    detail: missing.length ? `Missing events: ${missing.join(", ")}` : "All required events are subscribed",
                });
            }
        }
        return checks;
    },
};

const paypalDriver = {
    mode: "auto",
    events: paypal.PAYPAL_EVENTS,

    parseCredentials: (input) => paypal.parseCredentials(input),

    async connect({ creds, webhookUrl }) {
        const hook = await paypal.createWebhook({ creds, url: webhookUrl, events: paypal.PAYPAL_EVENTS });
        return {
            publicConfig: {
                gateway: "paypal",
                connectionMode: "auto",
                paypalEnvironment: creds.environment,
                webhookId: hook.id,
                enabledEvents: paypal.PAYPAL_EVENTS,
            },
            secrets: { clientId: creds.clientId, clientSecret: creds.clientSecret },
            fingerprint: sha256(`${creds.environment}:${creds.clientId}`),
            remoteRef: { id: hook.id },
            reveal: null,
        };
    },

    /** PayPal credentials are stored, so removal needs no extra input. */
    async removeRemote({ config, remoteId }) {
        const id = remoteId ?? config.webhookId;
        if (!id) return { removed: false, reason: "no_remote_webhook" };
        if (!config.clientId || !config.clientSecret) return { removed: false, reason: "credentials_not_stored" };
        const creds = { clientId: config.clientId, clientSecret: config.clientSecret, environment: config.paypalEnvironment ?? "sandbox" };
        const result = await paypal.deleteWebhook({ creds, id });
        return { removed: result.deleted, reason: result.alreadyGone ? "already_removed" : undefined };
    },

    async verify({ connector, config, webhookUrl }) {
        const hasCreds = Boolean(config.clientId && config.clientSecret && config.webhookId);
        const checks = [secretCheck(hasCreds), firstEventCheck(connector)];
        if (hasCreds) {
            const creds = { clientId: config.clientId, clientSecret: config.clientSecret, environment: config.paypalEnvironment ?? "sandbox" };
            const hook = await paypal.getWebhook({ creds, id: config.webhookId });
            checks.push({
                name: "remote_webhook_active",
                ok: Boolean(hook),
                detail: hook ? "PayPal webhook exists" : "The webhook no longer exists in PayPal",
            });
            if (hook) {
                checks.push({
                    name: "remote_url_matches",
                    ok: hook.url === webhookUrl,
                    detail: hook.url === webhookUrl ? "Webhook URL is correct" : `PayPal is sending events to ${hook.url}`,
                });
                const missing = paypal.PAYPAL_EVENTS.filter((event) => !hook.eventTypes.includes(event));
                checks.push({
                    name: "remote_events_subscribed",
                    ok: missing.length === 0,
                    detail: missing.length ? `Missing events: ${missing.join(", ")}` : "All required events are subscribed",
                });
            }
        }
        return checks;
    },
};

const razorpayDriver = {
    mode: "manual",
    events: razorpay.RAZORPAY_EVENTS,

    parseCredentials: () => ({}),

    async connect({ webhookUrl }) {
        const webhookSecret = razorpay.generateWebhookSecret();
        return {
            publicConfig: {
                gateway: "razorpay",
                connectionMode: "manual",
                enabledEvents: razorpay.RAZORPAY_EVENTS,
            },
            secrets: { webhookSecret },
            fingerprint: null,
            remoteRef: null,
            // shown to the merchant exactly once
            reveal: {
                webhookUrl,
                webhookSecret,
                events: razorpay.RAZORPAY_EVENTS,
                optionalEvents: razorpay.RAZORPAY_OPTIONAL_EVENTS,
                steps: razorpay.setupSteps({ webhookUrl }),
            },
        };
    },

    async removeRemote() {
        return { removed: false, reason: "manual_gateway" };
    },

    async verify({ connector, config }) {
        return [secretCheck(Boolean(config.webhookSecret)), firstEventCheck(connector)];
    },
};

export const drivers = { stripe: stripeDriver, paypal: paypalDriver, razorpay: razorpayDriver };

// ── Catalog (drives the frontend "Connect" modals) ───────────────────────────

export const GATEWAY_CATALOG = [
    {
        type: "stripe",
        label: "Stripe",
        mode: "auto",
        events: stripe.STRIPE_EVENTS,
        fields: [
            {
                name: "secretKey",
                label: "Stripe secret or restricted API key",
                type: "password",
                required: true,
                help: "Use a restricted key with Write access to 'Webhook Endpoints'. It is used once to create the webhook and is NOT stored.",
            },
        ],
        notes: ["Put the attribution token in PaymentIntent metadata (metadata.attribution_token). For Checkout Sessions use payment_intent_data.metadata."],
    },
    {
        type: "paypal",
        label: "PayPal",
        mode: "auto",
        events: paypal.PAYPAL_EVENTS,
        fields: [
            { name: "environment", label: "Environment", type: "select", options: ["sandbox", "live"], required: true },
            { name: "clientId", label: "Client ID", type: "text", required: true },
            { name: "clientSecret", label: "Client secret", type: "password", required: true, help: "Stored encrypted; needed to verify each incoming event." },
        ],
        notes: ["Pass the attribution token as custom_id when creating the PayPal order."],
    },
    {
        type: "razorpay",
        label: "Razorpay",
        mode: "manual",
        events: razorpay.RAZORPAY_EVENTS,
        fields: [],
        notes: [
            "Razorpay only allows creating webhooks through its API for partner accounts, so you add the webhook in your Razorpay dashboard using the URL and secret we generate.",
            "Pass the attribution token in payment notes (notes.attribution_token).",
        ],
    },
];

