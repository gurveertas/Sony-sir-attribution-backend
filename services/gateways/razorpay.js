/**
 * Razorpay adapter.
 *
 * Razorpay's create-webhook API exists only for partner / sub-merchant accounts (OAuth access token),
 * not for ordinary merchant API keys. So Razorpay is "assisted": we generate the signing secret and
 * the exact webhook URL + event list, and the merchant pastes them into their Razorpay dashboard.
 * The connector turns healthy when the first signed event arrives.
 */

import crypto from "crypto";

/** Required: events the platform processes. */
export const RAZORPAY_EVENTS = ["payment.captured", "refund.processed"];
/** Optional: also handled (idempotent with payment.captured). */
export const RAZORPAY_OPTIONAL_EVENTS = ["order.paid"];

export function generateWebhookSecret() {
    return crypto.randomBytes(24).toString("hex");
}

export function setupSteps({ webhookUrl, events = RAZORPAY_EVENTS }) {
    return [
        "Open the Razorpay Dashboard and go to Account & Settings → Webhooks.",
        "Click 'Add New Webhook'.",
        `Set the Webhook URL to: ${webhookUrl}`,
        "Paste the secret shown above into the 'Secret' field.",
        `Tick these events: ${events.join(", ")}.`,
        "Save. The connector turns healthy as soon as the first event is received.",
        "Make sure your checkout passes the attribution token in the payment 'notes' (notes.attribution_token).",
    ];
}
