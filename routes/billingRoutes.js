import { Router } from "express";
import { handleStripeBillingWebhook } from "../controllers/billingWebhookController.js";

const router = Router();

// Public webhook receiver for Stripe platform billing
router.post("/webhook", handleStripeBillingWebhook);

export default router;

