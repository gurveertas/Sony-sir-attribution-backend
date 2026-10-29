/**
 * Controller for incoming Stripe billing webhooks.
 */

import { db } from "../src/prisma/db.js";
import ENV from "../utils/env.js";
import { verifyStripeSignature } from "./connectorController.js";
import { processBillingWebhookEvent } from "../services/billingWebhookService.js";

const orm = () => db.orm.public;

/**
 * POST /api/billing/webhook
 * Headers: stripe-signature
 */
export const handleStripeBillingWebhook = async (req, res) => {
    try {
        const signature = req.headers["stripe-signature"];
        const secret = ENV.STRIPE_BILLING_WEBHOOK_SECRET;

        if (secret) {
            const rawBody = req.rawBody || JSON.stringify(req.body);
            if (!verifyStripeSignature(rawBody, signature, secret)) {
                return res.status(400).json({ message: "Invalid or expired Stripe signature" });
            }
        } else if (ENV.NODE_ENV === "production") {
            console.warn("[billing] STRIPE_BILLING_WEBHOOK_SECRET is not set in production. Webhooks cannot be verified.");
        }

        const event = req.body;
        if (!event || !event.type) {
            return res.status(400).json({ message: "Malformed webhook payload" });
        }

        const result = await processBillingWebhookEvent(orm(), event);
        return res.status(200).json({ received: true, result });
    } catch (error) {
        console.error("handleStripeBillingWebhook error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

