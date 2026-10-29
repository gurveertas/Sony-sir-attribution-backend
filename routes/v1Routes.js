/**
 * Public API v1 (scope 4.3)
 *
 * Auth: publishable key (browser, write-only, allowed origins only) or secret key (server).
 * Every write accepts an `Idempotency-Key` header; conversion writes are stored as raw events first
 * and can be processed asynchronously with `Prefer: respond-async` (202 + eventId).
 * Reads accept a SECRET key or a dashboard session. Lists support cursor pagination; every report and
 * list supports format=csv. Errors are always { message, code }.
 *
 * Write:  POST /touches  /identify  /checkout-sessions  /orders (/conversions)  /bookings  /refunds
 *         PATCH /orders/:id  /bookings/:id
 * Read:   GET /orders  /orders/:id/attribution  /customers  /customers/:id/journey  /bookings  /bookings/upcoming
 *         GET /reports/{summary,channels,campaigns,locations,trend,customers,cac,spend,bookings,journeys,coverage,data-quality,dashboard}
 *         GET /alerts
 */

import { Router } from "express";
import { v1Cors, apiKeyAuth } from "../middlewares/apiKeyAuth.js";
import { readAccess } from "../middlewares/readAuth.js";
import { idempotency, recordRawEvent } from "../middlewares/apiWrite.js";
import { recordTouch, identifyVisitor, createCheckoutSession } from "../controllers/trackingController.js";
import { createOrder, updateOrder, listOrders, getOrderAttribution } from "../controllers/orderController.js";
import { createBooking, updateBooking, listBookings, listUpcomingBookings } from "../controllers/bookingController.js";
import { createRefund, listRefunds } from "../controllers/refundController.js";
import { listCustomers, getCustomerJourney, mergeCustomersApi } from "../controllers/customerController.js";
import * as reports from "../controllers/reportsController.js";
import { requireModelAllowed } from "../middlewares/planGuards.js";

const router = Router();

// CORS for browser SDK calls (answers OPTIONS preflight)
router.use(v1Cors);

const pub = apiKeyAuth(["publishable"]);
const pubOrSecret = apiKeyAuth(["publishable", "secret"]);
const secretOnly = apiKeyAuth(["secret"]);
const write = idempotency();

// ── SDK tracking (publishable key) ─────────────────────────────────────────
router.post("/touches", pub, write, recordTouch);
router.post("/identify", pub, write, identifyVisitor);
router.post("/checkout-sessions", pub, write, createCheckoutSession);

// ── Conversion ingestion (publishable or secret key) ───────────────────────
// A publishable key is visible in page source, so anything it posts can be forged by a visitor.
// Send orders/bookings from your SERVER with a secret key when the revenue must be trustworthy.
router.post("/orders", pubOrSecret, write, recordRawEvent("order.paid"), createOrder);
router.post("/conversions", pubOrSecret, write, recordRawEvent("order.paid"), createOrder); // alias
router.post("/bookings", pubOrSecret, write, recordRawEvent("booking.created"), createBooking);

// ── Changes to existing records (SECRET key only) ──────────────────────────
router.patch("/orders/:id", secretOnly, write, recordRawEvent("order.updated", { withParamsId: true }), updateOrder);
router.patch("/bookings/:id", secretOnly, write, recordRawEvent("booking.updated", { withParamsId: true }), updateBooking);
router.post("/refunds", secretOnly, write, recordRawEvent("refund.created"), createRefund);
router.post("/customers/merge", secretOnly, write, mergeCustomersApi);

// ── Reads: dashboard session (company_admin / company_viewer) OR a SECRET key ─────────
const read = readAccess("company_admin", "company_viewer");

router.get("/orders", ...read, listOrders);
router.get("/refunds", ...read, listRefunds);
router.get("/orders/:id/attribution", ...read, requireModelAllowed, getOrderAttribution);
router.get("/customers", ...read, listCustomers);
router.get("/customers/:id/journey", ...read, getCustomerJourney);
router.get("/bookings", ...read, listBookings);
router.get("/bookings/upcoming", ...read, listUpcomingBookings);
router.get("/alerts", ...read, reports.getAlerts);

for (const [path, handler] of Object.entries({
    dashboard: reports.getDashboardOverview,
    summary: reports.getSummaryReport,
    channels: reports.getChannelsReport,
    campaigns: reports.getCampaignsReport,
    locations: reports.getLocationsReport,
    trend: reports.getTrendReport,
    customers: reports.getCustomersReport,
    cac: reports.getCacReport,
    spend: reports.getSpendReport,
    bookings: reports.getBookingsReport,
    journeys: reports.getJourneysReport,
    coverage: reports.getCoverageReport,
    "data-quality": reports.getDataQualityReport,
})) {
    router.get(`/reports/${path}`, ...read, requireModelAllowed, handler);
}

export default router;
