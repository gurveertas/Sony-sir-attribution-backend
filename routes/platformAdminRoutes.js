import express from "express";
import {
  getPlatformDashboard,
  listWorkspaces,
  getWorkspaceDetails,
  setWorkspaceStatus,
  updateWorkspaceSettings,
  listWorkspaceUsers,
  updateUser,
  listPlatformApiKeys,
  revokePlatformApiKey,
  listPlatformConnectors,
  setConnectorStatus,
  listPlatformWebhooks,
  updatePlatformWebhook,
  deleteUser,
} from "../controllers/platformAdminController.js";
import { getWorkspaceDashboard } from "../controllers/platformAdminDashboardController.js";

import { startSupportSession, endSupportSession, listMySupportSessions } from "../controllers/supportAccessController.js";
import { protectRoute, requireRole } from "../middlewares/protectRoute.js";

const router = express.Router();

// All routes require an authenticated platform admin.
router.use(protectRoute);
router.use(requireRole("platform_admin"));

router.post("/support-sessions", startSupportSession);
router.post("/support-sessions/:id/end", endSupportSession);
router.get("/support-sessions", listMySupportSessions);

router.get("/dashboard", getPlatformDashboard);

router.get("/workspaces", listWorkspaces);
router.get("/workspaces/:workspaceId", getWorkspaceDetails);
router.get("/workspaces/:workspaceId/dashboard", getWorkspaceDashboard);
router.patch("/workspaces/:workspaceId/status", setWorkspaceStatus);
router.patch("/workspaces/:workspaceId/settings", updateWorkspaceSettings);
router.get("/workspaces/:workspaceId/users", listWorkspaceUsers);

router.patch("/users/:userId", updateUser);
router.delete('/users/:userId', deleteUser);

router.get("/api-keys", listPlatformApiKeys);
router.post("/api-keys/:keyId/revoke", revokePlatformApiKey);

router.get("/connectors", listPlatformConnectors);
router.patch("/connectors/:connectorId/status", setConnectorStatus);

router.get("/webhooks", listPlatformWebhooks);
router.patch("/webhooks/:webhookId", updatePlatformWebhook);

export default router;
