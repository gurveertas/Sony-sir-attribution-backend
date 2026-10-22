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
import {
    getDashboardOverview,
    getSummaryReport,
    getChannelsReport,
    getCampaignsReport,
    getLocationsReport,
    getTrendReport,
    getCustomersReport,
} from "../controllers/reportsController.js";
import { listCustomers, getCustomerJourney, mergeCustomersHandler } from "../controllers/customerController.js";
import { listOrders } from "../controllers/orderController.js";
import { listBookings, listUpcomingBookings } from "../controllers/bookingController.js";

const router = Router();

// Invite acceptance is the only public workspace route.
router.post("/invites/accept", acceptInvite);

router.use(protectRoute);
router.delete("/:workspaceId", deleteWorkspace);


// ── Settings (company_admin only) ──────────────────────────────────────────
router.get("/settings", requireRole("company_admin", "platform_admin"), getWorkspaceSettings);
router.patch("/settings", requireRole("company_admin", "platform_admin"), updateWorkspaceSettings);

// ── Team / Invites ─────────────────────────────────────────────────────────
router.post("/invites", requireRole("company_admin", "platform_admin"), inviteUser);
router.get("/team", requireRole("company_admin", "company_viewer", "platform_admin"), listTeam);
router.patch("/team/:userId", requireRole("company_admin", "platform_admin"), updateTeamMember);

// ── Locations ──────────────────────────────────────────────────────────────
router.get("/locations", requireRole("company_admin", "company_viewer", "platform_admin"), listLocations);
router.post("/locations", requireRole("company_admin", "platform_admin"), createLocation);
router.patch("/locations/:id", requireRole("company_admin", "platform_admin"), updateLocation);
router.delete("/locations/:id", requireRole("company_admin", "platform_admin"), deleteLocation);

// ── Channel Mapping Rules ──────────────────────────────────────────────────
router.get("/channel-rules", requireRole("company_admin", "platform_admin"), listChannelMappingRules);
router.post("/channel-rules", requireRole("company_admin", "platform_admin"), createChannelMappingRule);
router.patch("/channel-rules/:id", requireRole("company_admin", "platform_admin"), updateChannelMappingRule);
router.delete("/channel-rules/:id", requireRole("company_admin", "platform_admin"), deleteChannelMappingRule);

// ── Outbound Webhooks ──────────────────────────────────────────────────────
router.get("/webhooks", requireRole("company_admin", "platform_admin"), listWebhookEndpoints);
router.post("/webhooks", requireRole("company_admin", "platform_admin"), createWebhookEndpoint);
router.patch("/webhooks/:id", requireRole("company_admin", "platform_admin"), updateWebhookEndpoint);
router.delete("/webhooks/:id", requireRole("company_admin", "platform_admin"), deleteWebhookEndpoint);

// ── Audit Log ──────────────────────────────────────────────────────────────
router.get("/audit-log", requireRole("company_admin", "platform_admin"), getAuditLog);

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

router.get("/connectors", requireRole("company_admin", "platform_admin"), listConnectors);

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
router.post("/connectors", requireRole("company_admin", "platform_admin"), createConnector);
router.patch("/connectors/:id", requireRole("company_admin", "platform_admin"), updateConnector);
router.delete("/connectors/:id", requireRole("company_admin", "platform_admin"), deleteConnector);
router.get("/connectors/:id/events", requireRole("company_admin", "platform_admin"), listConnectorEvents);
router.post("/connectors/:id/events/:eventId/replay", requireRole("company_admin", "platform_admin"), replayEvent);

// ── Elysium Dashboard & Analytics (Cookie-Authenticated) ───────────────────
router.get("/dashboard", requireRole("company_admin", "company_viewer", "platform_admin"), getDashboardOverview);
router.get("/reports/dashboard", requireRole("company_admin", "company_viewer", "platform_admin"), getDashboardOverview);
router.get("/reports/summary", requireRole("company_admin", "company_viewer", "platform_admin"), getSummaryReport);
router.get("/reports/channels", requireRole("company_admin", "company_viewer", "platform_admin"), getChannelsReport);
router.get("/reports/campaigns", requireRole("company_admin", "company_viewer", "platform_admin"), getCampaignsReport);
router.get("/reports/locations", requireRole("company_admin", "company_viewer", "platform_admin"), getLocationsReport);
router.get("/reports/trend", requireRole("company_admin", "company_viewer", "platform_admin"), getTrendReport);
router.get("/reports/customers", requireRole("company_admin", "company_viewer", "platform_admin"), getCustomersReport);

// ── Customers & Journeys ───────────────────────────────────────────────────
router.post("/customers/merge", requireRole("company_admin"), mergeCustomersHandler);
router.get("/customers", requireRole("company_admin", "company_viewer", "platform_admin"), listCustomers);
router.get("/customers/:id/journey", requireRole("company_admin", "company_viewer", "platform_admin"), getCustomerJourney);

// ── Transactions / Orders ──────────────────────────────────────────────────
router.get("/transactions", requireRole("company_admin", "company_viewer", "platform_admin"), listOrders);
router.get("/orders", requireRole("company_admin", "company_viewer", "platform_admin"), listOrders);

// ── Upcoming / Bookings ────────────────────────────────────────────────────
router.get("/upcoming", requireRole("company_admin", "company_viewer", "platform_admin"), listUpcomingBookings);
router.get("/bookings", requireRole("company_admin", "company_viewer", "platform_admin"), listBookings);

export default router;
