/**
 * Connector Webhook Routes — /api/connectors/*
 *
 * Inbound webhooks from payment/booking systems.
 * These routes do NOT use JWT auth — they verify using connector-specific
 * secrets (HMAC signatures or Stripe webhook signatures).
 */

import { Router } from "express";
import {
    stripeWebhook,
    shopifyWebhook,
    zenotiWebhook,
    razorpayWebhook,
    paypalWebhook,
    genericWebhook,
} from "../controllers/connectorController.js";

const router = Router();

// Every webhook is reachable two ways:
//   /<type>/webhook/:connectorId   (used for webhooks created automatically)
//   /<type>/webhook?connectorId=   (legacy / manually configured webhooks)
const mount = (type, handler) => {
    router.post(`/${type}/webhook/:connectorId`, handler);
    router.post(`/${type}/webhook`, handler);
};

mount("stripe", stripeWebhook);
mount("shopify", shopifyWebhook);
mount("zenoti", zenotiWebhook);
mount("razorpay", razorpayWebhook);
mount("paypal", paypalWebhook);
mount("generic", genericWebhook);
mount("woocommerce", genericWebhook);
mount("square", genericWebhook);

export default router;
