/**
 * Connector Webhook Controllers
 *
 * Each connector:
 * 1. Verifies the webhook signature
 * 2. Saves the raw payload to RawEvent (before any processing) and acknowledges immediately
 * 3. The event queue normalizes the payload to a canonical event and runs the shared ingestion
 *    pipeline (services/connectorProcessors.js -> services/ingestion.js — the same code replay uses),
 *    retrying with backoff and parking repeated failures in the dead-letter state
 * 4. Connector health (lastEventAt, healthy / failing, error count) is recorded by the queue
 *
 * Routes accept the connector id either as a path param (/stripe/webhook/:connectorId — used for
 * webhooks we create automatically) or as ?connectorId= (legacy / manually configured webhooks).
 *
 * Provider secrets are loaded from encrypted connector storage.
 */

import crypto from "crypto";
import { getConnectorConfig, getNestedValue, getRawBody, verifyHmacSignature } from "../utils/connectorConfig.js";
import { lookupConnector, lookupWorkspace } from "../services/connectorRuntime.js";
import { acceptEvent } from "../services/eventQueue.js";
import { GatewayError } from "../services/gateways/http.js";
import { verifyWebhookSignature as verifyPayPalSignature } from "../services/gateways/paypal.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

export function verifyStripeSignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader || !secret) return false;
    const fields = signatureHeader.split(",").map((part) => part.split("=", 2));
    const timestamp = fields.find(([key]) => key === "t")?.[1];
    const signatures = fields.filter(([key]) => key === "v1").map(([, value]) => value);
    const timestampSeconds = Number(timestamp);
    if (!Number.isInteger(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false;

    const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
    return signatures.some((signature) => {
        const received = Buffer.from(signature, "hex");
        return received.length === expected.length && crypto.timingSafeEqual(received, expected);
    });
}

/**
 * Finds + validates the connector for an incoming webhook.
 * Returns null after writing the response when the request must stop.
 */
async function resolveConnector(req, res, allowedTypes, wrongTypeMessage) {
    const connectorId = req.params?.connectorId || req.query.connectorId;
    if (!connectorId) {
        res.status(400).json({ message: "connectorId required" });
        return null;
    }
    const connector = await lookupConnector(connectorId);
    if (!connector) {
        res.status(404).json({ message: "Connector not found" });
        return null;
    }
    if (!allowedTypes.includes(connector.type)) {
        res.status(400).json({ message: wrongTypeMessage });
        return null;
    }
    const workspace = await lookupWorkspace(connector.workspaceId);
    if (!workspace || workspace.status !== "active") {
        res.status(200).json({ received: true, ignored: "workspace_inactive" });
        return null;
    }
    if (connector.status === "disabled") {
        // Acknowledge so the gateway does not keep retrying; nothing is stored or processed.
        res.status(200).json({ received: true, ignored: "connector_disabled" });
        return null;
    }
    return connector;
}

/**
 * Persist -> acknowledge -> process in the background (services/eventQueue.js).
 * The gateway gets its 200 as soon as the raw payload is stored (scope 4.12: acknowledge within
 * 200 ms, process asynchronously). If the payload cannot be stored we answer 503 so the gateway
 * retries: an event is never acknowledged and then lost.
 */
async function ingest({ res, connector, source, eventType, payload, label }) {
    let raw;
    try {
        raw = await acceptEvent({ workspaceId: connector.workspaceId, connector, source, eventType, payload });
    } catch (err) {
        console.error(`${label}: could not store event:`, err.message);
        return res.status(503).json({ message: "Temporarily unable to accept events, please retry" });
    }
    return res.status(200).json({ received: true, eventId: raw.id });
}

// ── Stripe ───────────────────────────────────────────────────────────────────

/**
 * POST /api/connectors/stripe/webhook/:connectorId   (or ?connectorId=)
 * Headers: stripe-signature
 */
export const stripeWebhook = async (req, res) => {
    const connector = await resolveConnector(req, res, ["stripe"], "Connector is not configured for Stripe");
    if (!connector) return;

    const rawBody = getRawBody(req);
    const config = getConnectorConfig(connector);
    if (!config.webhookSecret) return res.status(500).json({ message: "Connector is missing webhookSecret in config" });

    if (!verifyStripeSignature(rawBody, req.headers["stripe-signature"], config.webhookSecret)) {
        return res.status(400).json({ message: "Invalid or expired Stripe signature" });
    }

    let event;
    try {
        event = JSON.parse(rawBody);
    } catch {
        return res.status(400).json({ message: "Invalid JSON webhook payload" });
    }

    return ingest({ res, connector, source: "stripe", eventType: event.type, payload: event, label: "stripeWebhook" });
};

// ── Shopify ──────────────────────────────────────────────────────────────────

/**
 * POST /api/connectors/shopify/webhook/:connectorId
 * Headers: X-Shopify-Hmac-Sha256, X-Shopify-Topic
 */
export const shopifyWebhook = async (req, res) => {
    const connector = await resolveConnector(req, res, ["shopify"], "Connector is not configured for Shopify");
    if (!connector) return;

    const config = getConnectorConfig(connector);
    const sharedSecret = config.sharedSecret || config.webhookSecret;
    if (!sharedSecret) return res.status(500).json({ message: "Connector is missing sharedSecret in config" });

    if (
        !verifyHmacSignature({
            secret: sharedSecret,
            signature: req.headers["x-shopify-hmac-sha256"],
            payload: getRawBody(req),
            encoding: "base64",
        })
    ) {
        return res.status(401).json({ message: "Invalid Shopify HMAC signature" });
    }

    const topic = req.headers["x-shopify-topic"] || "";
    return ingest({ res, connector, source: "shopify", eventType: topic, payload: req.body, label: "shopifyWebhook" });
};

// ── Zenoti ───────────────────────────────────────────────────────────────────

/**
 * POST /api/connectors/zenoti/webhook/:connectorId
 * Zenoti sends appointment/invoice/guest events.
 */
export const zenotiWebhook = async (req, res) => {
    const connector = await resolveConnector(req, res, ["zenoti"], "Connector is not configured for Zenoti");
    if (!connector) return;

    const config = getConnectorConfig(connector);
    if (!config.webhookSecret) return res.status(500).json({ message: "Connector is missing webhookSecret in config" });

    if (
        !verifyHmacSignature({
            secret: config.webhookSecret,
            signature: req.headers["x-zenoti-signature"],
            payload: getRawBody(req),
            encoding: config.signatureEncoding || "hex",
            prefix: config.signaturePrefix || "",
        })
    ) {
        return res.status(401).json({ message: "Invalid Zenoti signature" });
    }

    const payload = req.body;
    const eventType = payload?.event_type || payload?.type || "unknown";
    return ingest({ res, connector, source: "zenoti", eventType, payload, label: "zenotiWebhook" });
};

// ── Razorpay ─────────────────────────────────────────────────────────────────

/**
 * POST /api/connectors/razorpay/webhook/:connectorId
 * Headers: X-Razorpay-Signature
 */
export const razorpayWebhook = async (req, res) => {
    const connector = await resolveConnector(req, res, ["razorpay"], "Connector is not configured for Razorpay");
    if (!connector) return;

    const config = getConnectorConfig(connector);
    if (!config.webhookSecret) return res.status(500).json({ message: "Connector is missing webhookSecret in config" });

    if (
        !verifyHmacSignature({
            secret: config.webhookSecret,
            signature: req.headers["x-razorpay-signature"],
            payload: getRawBody(req),
            encoding: "hex",
        })
    ) {
        return res.status(401).json({ message: "Invalid Razorpay signature" });
    }

    const payload = req.body;
    const eventType = payload?.event || "unknown";
    return ingest({ res, connector, source: "razorpay", eventType, payload, label: "razorpayWebhook" });
};

// ── PayPal ───────────────────────────────────────────────────────────────────

const PAYPAL_SIGNATURE_HEADERS = [
    "paypal-auth-algo",
    "paypal-cert-url",
    "paypal-transmission-id",
    "paypal-transmission-sig",
    "paypal-transmission-time",
];

/**
 * POST /api/connectors/paypal/webhook/:connectorId
 * Headers: PAYPAL-TRANSMISSION-* (verified through PayPal's verify-webhook-signature API)
 */
export const paypalWebhook = async (req, res) => {
    const connector = await resolveConnector(req, res, ["paypal"], "Connector is not configured for PayPal");
    if (!connector) return;

    let config;
    try {
        config = getConnectorConfig(connector);
    } catch (error) {
        console.error("PayPal webhook config error:", error.message);
        return res.status(500).json({ message: "PayPal connector configuration is invalid" });
    }
    if (!config.clientId || !config.clientSecret || !config.webhookId) {
        return res.status(500).json({ message: "PayPal connector requires clientId, clientSecret, and webhookId" });
    }
    if (PAYPAL_SIGNATURE_HEADERS.some((header) => !req.headers[header])) {
        return res.status(400).json({ message: "PayPal webhook is missing signature headers" });
    }

    let valid;
    try {
        valid = await verifyPayPalSignature({
            creds: {
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                environment: config.paypalEnvironment === "live" ? "live" : "sandbox",
            },
            webhookId: config.webhookId,
            headers: req.headers,
            event: req.body,
        });
    } catch (error) {
        console.error("PayPal webhook verification failed:", error instanceof GatewayError ? error.message : "unexpected error");
        return res.status(503).json({ message: "PayPal signature verification is temporarily unavailable" });
    }
    if (!valid) return res.status(401).json({ message: "Invalid PayPal webhook signature" });

    const payload = req.body;
    const eventType = payload?.event_type || "unknown";
    return ingest({ res, connector, source: "paypal", eventType, payload, label: "paypalWebhook" });
};

// ── Generic REST Webhook (also WooCommerce / Square) ─────────────────────────

export const genericWebhook = async (req, res) => {
    const connector = await resolveConnector(
        req,
        res,
        ["generic", "woocommerce", "square"],
        "Connector does not use the configurable HMAC webhook",
    );
    if (!connector) return;

    const config = getConnectorConfig(connector);
    if (!config.webhookSecret) return res.status(500).json({ message: "Connector is missing webhookSecret in config" });

    const signature = req.headers[String(config.signatureHeader || "x-signature").toLowerCase()];
    const signaturePayload = config.signatureIncludeUrl
        ? `${config.notificationUrl || `${req.protocol}://${req.get("host")}${req.originalUrl}`}${getRawBody(req)}`
        : getRawBody(req);
    if (
        !verifyHmacSignature({
            secret: config.webhookSecret,
            signature,
            payload: signaturePayload,
            encoding: config.signatureEncoding || "hex",
            prefix: config.signaturePrefix || "",
        })
    ) {
        return res.status(401).json({ message: "Invalid signature" });
    }

    const payload = req.body;
    const eventType = config.eventTypeHeader
        ? req.headers[String(config.eventTypeHeader).toLowerCase()]
        : getNestedValue(payload, config.eventTypeField || "type");

    return ingest({
        res,
        connector,
        source: connector.type,
        eventType: eventType || "unknown",
        payload,
        label: "genericWebhook",
    });
};
