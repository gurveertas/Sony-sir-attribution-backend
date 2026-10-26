/**
 * Platform admin "view as company" — /api/view/*  (read-only, support session required, audited)
 * Every path ends with the workspace id so the frontend can attach the session for that company.
 */
import { Router } from "express";
import { protectRoute, requireRole } from "../middlewares/protectRoute.js";
import * as v from "../controllers/platformAdminDashboardController.js";

const router = Router();

router.use(protectRoute, requireRole("platform_admin"));

router.get("/workspace/:workspaceId", v.getWorkspaceDashboard);
router.get("/customers/workspace/:workspaceId", v.listCustomerView);
router.get("/customers/:id/journey/:workspaceId", v.getCustomerJourneyView);
router.get("/transactions/workspace/:workspaceId", v.listTransactionsView);
router.get("/refunds/workspace/:workspaceId", v.listRefundsView);
router.get("/orders/:id/attribution/:workspaceId", v.getOrderAttributionView);
router.get("/bookings/workspace/:workspaceId", v.listBookingsView);
router.get("/upcoming/workspace/:workspaceId", v.listUpcomingView);
router.get("/alerts/:workspaceId", v.getAlertsView);
router.get("/reports/summary/:workspaceId", v.getSummaryReportView);
router.get("/reports/channels/:workspaceId", v.getChannelsReportView);
router.get("/reports/campaigns/:workspaceId", v.getCampaignsReportView);
router.get("/reports/locations/:workspaceId", v.getLocationsReportView);
router.get("/reports/trends/:workspaceId", v.getTrendReportView);
router.get("/reports/trend/:workspaceId", v.getTrendReportView);
router.get("/reports/customers/:workspaceId", v.getCustomerReportView);
router.get("/reports/cac/:workspaceId", v.getCacReportView);
router.get("/reports/spend/:workspaceId", v.getSpendReportView);
router.get("/reports/bookings/:workspaceId", v.getBookingsReportView);
router.get("/reports/journeys/:workspaceId", v.getJourneysReportView);
router.get("/reports/coverage/:workspaceId", v.getCoverageReportView);
router.get("/reports/data-quality/:workspaceId", v.getDataQualityReportView);

export default router;
