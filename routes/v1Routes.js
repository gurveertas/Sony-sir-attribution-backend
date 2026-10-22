/**
 * Public V1 API Routes
 *
 * Tracking and data APIs use API keys. Report APIs use the authenticated
 * company user's session cookie and role.
 * The v1Cors middleware handles CORS for browser-based calls.
 *
 * Write endpoints (SDK + connectors):
 *   POST /v1/touches
 *   POST /v1/identify
 *   POST /v1/checkout-sessions
 *   POST /v1/orders  (or /v1/conversions)
 *   PATCH /v1/orders/:id
 *   POST /v1/bookings
 *   PATCH /v1/bookings/:id
 *   POST /v1/refunds
 *
 * Read endpoints:
 *   GET /v1/orders
 *   GET /v1/orders/:id/attribution
 *   GET /v1/customers
 *   GET /v1/customers/:id/journey
 *   GET /v1/bookings
 *   GET /v1/bookings/upcoming
 *   GET /v1/reports/summary
 *   GET /v1/reports/channels
 *   GET /v1/reports/campaigns
 *   GET /v1/reports/locations
 *   GET /v1/reports/trend
 *   GET /v1/reports/customers
 */

import { Router } from "express";
import { v1Cors, apiKeyAuth } from "../middlewares/apiKeyAuth.js";
import { readAccess } from "../middlewares/readAuth.js";
import { recordTouch, identifyVisitor, createCheckoutSession } from "../controllers/trackingController.js";
import { createOrder, updateOrder, listOrders, getOrderAttribution } from "../controllers/orderController.js";
import { createBooking, updateBooking, listBookings, listUpcomingBookings } from "../controllers/bookingController.js";
import { createRefund } from "../controllers/refundController.js";
import { listCustomers, getCustomerJourney } from "../controllers/customerController.js";
import {
    getDashboardOverview,
    getSummaryReport,
    getChannelsReport,
    getCampaignsReport,
    getLocationsReport,
    getTrendReport,
    getCustomersReport,
} from "../controllers/reportsController.js";

const router = Router();

// CORS middleware for browser-based SDK calls (answers OPTIONS preflight)
router.use(v1Cors);

// ── Write endpoints (publishable key accepted) ─────────────────────────────

router.post("/touches", apiKeyAuth(["publishable"]), recordTouch);
router.post("/identify", apiKeyAuth(["publishable"]), identifyVisitor);
router.post("/checkout-sessions", apiKeyAuth(["publishable"]), createCheckoutSession);

// ── Conversion ingestion (publishable or secret key) ───────────────────────
// A publishable key is visible in page source, so anything it posts can be forged by a visitor.
// Send orders/bookings from your SERVER with a secret key when the revenue must be trustworthy.

router.post("/orders", apiKeyAuth(["publishable", "secret"]), createOrder);
router.post("/conversions", apiKeyAuth(["publishable", "secret"]), createOrder); // alias
router.post("/bookings", apiKeyAuth(["publishable", "secret"]), createBooking);

// ── Changes to existing records (SECRET key only) ──────────────────────────
// Refunds and edits must never be possible with a key that is public.

router.patch("/orders/:id", apiKeyAuth(["secret"]), updateOrder);
router.patch("/bookings/:id", apiKeyAuth(["secret"]), updateBooking);
router.post("/refunds", apiKeyAuth(["secret"]), createRefund);

// ── Read endpoints ─────────────────────────────────────────────────────────
// Dashboard session cookie (company_admin / company_viewer) OR a SECRET API key.
const reportAccess = readAccess("company_admin", "company_viewer", "platform_admin");

router.get("/orders", ...reportAccess, listOrders);
router.get("/orders/:id/attribution", ...reportAccess, getOrderAttribution);

router.get("/customers", ...reportAccess, listCustomers);
router.get("/customers/:id/journey", ...reportAccess, getCustomerJourney);

router.get("/bookings", ...reportAccess, listBookings);
router.get("/bookings/upcoming", ...reportAccess, listUpcomingBookings);

// ── Report endpoints (same access rules as the reads above) ─────────────────────────────────


router.get("/reports/dashboard", ...reportAccess, getDashboardOverview);
router.get("/reports/summary", ...reportAccess, getSummaryReport);
router.get("/reports/channels", ...reportAccess, getChannelsReport);
router.get("/reports/campaigns", ...reportAccess, getCampaignsReport);
router.get("/reports/locations", ...reportAccess, getLocationsReport);
router.get("/reports/trend", ...reportAccess, getTrendReport);
router.get("/reports/customers", ...reportAccess, getCustomersReport);

export default router;
