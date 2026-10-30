import { Router } from "express";
import { handleStripeBillingWebhook } from "../controllers/billingWebhookController.js";
import { getAvailablePlans } from "../controllers/billingController.js";
import {protectRoute} from '../middlewares/protectRoute.js';

const router = Router();

// Public plan catalog (can be consumed by public pricing page or dashboard)
router.get("/plans", protectRoute, getAvailablePlans);

// Public webhook receiver for Stripe platform billing
router.post("/webhook", handleStripeBillingWebhook);

export default router;

