/**
 * Workspace Routes — /api/workspace/*
 *
 * Company admin endpoints for managing workspace settings, team,
 * locations, channel mapping rules, webhooks, and audit log.
 */

import { Router } from "express";
import { protectRoute, requireRole } from "../middlewares/protectRoute.js";
import {
    getWorkspaceSettings,
    deleteWorkspace,
    updateWorkspaceSettings,
    inviteUser,
    acceptInvite,
    listTeam,
    updateTeamMember,
    listLocations,
    createLocation,
    updateLocation,
    deleteLocation,
    listChannelMappingRules,
    createChannelMappingRule,
    updateChannelMappingRule,
    deleteChannelMappingRule,
    listWebhookEndpoints,
    createWebhookEndpoint,
    updateWebhookEndpoint,
    deleteWebhookEndpoint,
    getAuditLog,
} from "../controllers/workspaceController.js";
import * as reports from "../controllers/reportsController.js";
import { listCustomers, getCustomerJourney, mergeCustomersHandler } from "../controllers/customerController.js";
import { listOrders, getOrderAttribution } from "../controllers/orderController.js";
import { listRefunds } from "../controllers/refundController.js";
import * as tools from "../controllers/workspaceToolsController.js";
import { listBookings, listUpcomingBookings } from "../controllers/bookingController.js";

const router = Router();

// Invite acceptance is the only public workspace route.
router.post("/invites/accept", acceptInvite);

router.use(protectRoute);


// ── Settings (company_admin only) ──────────────────────────────────────────
router.get("/settings", requireRole("company_admin"), getWorkspaceSettings);
router.patch("/settings", requireRole("company_admin"), updateWorkspaceSettings);

// ── Team / Invites ─────────────────────────────────────────────────────────
router.post("/invites", requireRole("company_admin"), inviteUser);
router.get("/team", requireRole("company_admin", "company_viewer"), listTeam);
router.patch("/team/:userId", requireRole("company_admin"), updateTeamMember);

// ── Locations ──────────────────────────────────────────────────────────────
router.get("/locations", requireRole("company_admin", "company_viewer"), listLocations);
router.post("/locations", requireRole("company_admin"), createLocation);
router.patch("/locations/:id", requireRole("company_admin"), updateLocation);
router.delete("/locations/:id", requireRole("company_admin"), deleteLocation);

// ── Channel Mapping Rules ──────────────────────────────────────────────────
router.get("/channel-rules", requireRole("company_admin"), listChannelMappingRules);
router.post("/channel-rules", requireRole("company_admin"), createChannelMappingRule);
router.patch("/channel-rules/:id", requireRole("company_admin"), updateChannelMappingRule);
router.delete("/channel-rules/:id", requireRole("company_admin"), deleteChannelMappingRule);

// ── Outbound Webhooks ──────────────────────────────────────────────────────
router.get("/webhooks", requireRole("company_admin"), listWebhookEndpoints);
router.post("/webhooks", requireRole("company_admin"), createWebhookEndpoint);
router.patch("/webhooks/:id", requireRole("company_admin"), updateWebhookEndpoint);
router.delete("/webhooks/:id", requireRole("company_admin"), deleteWebhookEndpoint);

// ── Audit Log ──────────────────────────────────────────────────────────────
router.get("/audit-log", requireRole("company_admin"), getAuditLog);

// ── Connectors (company manages their integrations) ────────────────────────
import {
    createConnector,
    listConnectors,
    updateConnector,
    deleteConnector,
    listConnectorEvents,
    getConnectorEvent,
    replayFailedEvents,
    replayEvent,
} from "../controllers/connectorManagementController.js";
import {
    listGatewayCatalog,
    connectGateway,
    getConnector,
    reconnectConnector,
    disconnectConnector,
    verifyConnector,
} from "../controllers/gatewayConnectController.js";
import { listSupportAccess } from "../controllers/supportAccessController.js";

router.get("/connectors", requireRole("company_admin"), listConnectors);

// One-click payment-gateway connect (Stripe / PayPal / Razorpay). company_admin only: handles gateway credentials.
// NOTE: static paths must be declared before "/connectors/:id".
router.get("/connectors/gateways", requireRole("company_admin"), listGatewayCatalog);
router.post("/connectors/connect", requireRole("company_admin"), connectGateway);
router.get("/connectors/:id", requireRole("company_admin"), getConnector);
router.post("/connectors/:id/reconnect", requireRole("company_admin"), reconnectConnector);
router.post("/connectors/:id/disconnect", requireRole("company_admin"), disconnectConnector);
router.post("/connectors/:id/verify", requireRole("company_admin"), verifyConnector);
router.post("/connectors/:id/events/replay-failed", requireRole("company_admin"), replayFailedEvents);
router.get("/connectors/:id/events/:eventId", requireRole("company_admin"), getConnectorEvent);

// Who from platform support looked at this company's data, and why.
router.get("/support-access", requireRole("company_admin"), listSupportAccess);
router.post("/connectors", requireRole("company_admin"), createConnector);
router.patch("/connectors/:id", requireRole("company_admin"), updateConnector);
router.delete("/connectors/:id", requireRole("company_admin"), deleteConnector);
router.get("/connectors/:id/events", requireRole("company_admin"), listConnectorEvents);
router.post("/connectors/:id/events/:eventId/replay", requireRole("company_admin"), replayEvent);

// ── Dashboard & reports (cookie session; every report also exists under /v1/reports/*) ─────
const anyRole = requireRole("company_admin", "company_viewer");
router.get("/dashboard", anyRole, reports.getDashboardOverview);
router.get("/alerts", anyRole, reports.getAlerts);
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
    router.get(`/reports/${path}`, anyRole, handler);
}

// ── Customers & journeys ───────────────────────────────────────────────────
router.post("/customers/merge", requireRole("company_admin"), mergeCustomersHandler);
router.get("/customers", anyRole, listCustomers);
router.get("/customers/:id/journey", anyRole, getCustomerJourney);
router.get("/customers/:id/export", requireRole("company_admin"), tools.exportCustomerData);
router.post("/customers/:id/erase", requireRole("company_admin"), tools.eraseCustomerData);

// ── Transactions / orders / bookings ───────────────────────────────────────
router.get("/transactions", anyRole, listOrders);
router.get("/orders", anyRole, listOrders);
router.get("/refunds", anyRole, listRefunds);
router.get("/orders/:id/attribution", anyRole, getOrderAttribution);
router.get("/upcoming", anyRole, listUpcomingBookings);
router.get("/bookings", anyRole, listBookings);

// ── Onboarding, live feed, re-run tools ────────────────────────────────────
router.get("/setup-checklist", anyRole, tools.getSetupChecklist);
router.post("/test-events", requireRole("company_admin"), tools.postTestEvent);
router.get("/events/live", anyRole, tools.getLiveFeed);
router.post("/attribution/rerun", requireRole("company_admin"), tools.postRerunAttribution);
router.post("/rollups/rebuild", requireRole("company_admin"), tools.postRebuildRollups);

// ── Ad spend ───────────────────────────────────────────────────────────────
router.get("/ad-accounts", requireRole("company_admin"), tools.listAdAccounts);
router.post("/ad-accounts/oauth/:platform/start", requireRole("company_admin"), tools.startAdOAuth);
router.patch("/ad-accounts/:id", requireRole("company_admin"), tools.updateAdAccount);
router.delete("/ad-accounts/:id", requireRole("company_admin"), tools.deleteAdAccount);
router.post("/ad-accounts/:id/sync", requireRole("company_admin"), tools.syncAdAccountNow);
router.post("/ad-spend/upload", requireRole("company_admin"), tools.uploadAdSpend);
router.get("/ad-spend", anyRole, tools.listAdSpend);

// ── Outbound webhooks: delivery log, test, secret rotation ─────────────────
router.get("/webhook-event-types", requireRole("company_admin"), tools.listWebhookEventTypes);
router.get("/webhooks/:id/deliveries", requireRole("company_admin"), tools.listWebhookDeliveries);
router.post("/webhooks/:id/test", requireRole("company_admin"), tools.testWebhook);
router.post("/webhooks/:id/rotate-secret", requireRole("company_admin"), tools.rotateWebhookSecret);
router.post("/webhooks/deliveries/:deliveryId/retry", requireRole("company_admin"), tools.retryWebhookDelivery);

// ── Data: export ───────────────────────────────────────────────────────────
router.get("/data/export", requireRole("company_admin"), tools.exportWorkspaceData);

// Close the company account (company admin) / delete it (platform admin, audited purge).
// Declared last so it never shadows a static path.
router.delete("/:workspaceId", requireRole("company_admin", "platform_admin"), deleteWorkspace);

export default router;
