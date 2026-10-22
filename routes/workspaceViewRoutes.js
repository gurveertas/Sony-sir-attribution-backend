import { Router } from "express";
import { protectRoute, requireRole } from "../middlewares/protectRoute.js";
import {
  getSummaryReportView,
  getWorkspaceDashboard,
  listCustomerView,
  getCampaignsReportView,
  getChannelsReportView,
  getLocationsReportView,
  getTrendReportView,
  getCustomerReportView,
} from "../controllers/platformAdminDashboardController.js";

const router = Router();

router.use(protectRoute, requireRole("platform_admin"));

router.get("/workspace/:workspaceId", getWorkspaceDashboard);
router.get("/customers/workspace/:workspaceId", listCustomerView);
router.get("/reports/summary/:workspaceId", getSummaryReportView);
router.get("/reports/channels/:workspaceId", getChannelsReportView);
router.get("/reports/campaigns/:workspaceId", getCampaignsReportView);
router.get("/reports/locations/:workspaceId", getLocationsReportView);
router.get("/reports/trends/:workspaceId", getTrendReportView);
router.get("/reports/customers/:workspaceId", getCustomerReportView);

export default router;
