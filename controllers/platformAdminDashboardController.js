/**
 * Read-only aggregate data for the platform administrator dashboard.
 * Unlike company reports, these queries intentionally span workspaces and must remain admin-only.
 */

import { db } from "../src/prisma/db.js";
import { getDashboardOverview, getSummaryReport, getCampaignsReport, getChannelsReport, getLocationsReport, getTrendReport, getCustomersReport} from "./reportsController.js";
import { listCustomers } from "./customerController.js";

import { SupportAccessError, auditSupport, loadActiveSession, supportAccessRequired } from "../services/supportAccess.js";

const orm = () => db.orm.public;

/**
 * Gate for every /api/view/* handler. Returns the workspace, or null after writing the response.
 * Requires an active support session (a written reason + audit trail); PII is masked unless the
 * session explicitly unmasks it.
 */
const commonChecks = async (req, res) => {
  try {
    if (req.user?.role !== "platform_admin") {
      res.status(403).json({ message: "Platform admins only" });
      return null;
    }

    const workspaceId = req.params.workspaceId;
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0 || workspaceId.length > 200) {
      res.status(400).json({ message: "A valid workspace id is required." });
      return null;
    }
    const workspace = await orm().Workspace.where({ id: workspaceId }).first();
    if (!workspace) {
      res.status(404).json({ message: "Workspace not found." });
      return null;
    }

    if (supportAccessRequired()) {
      const session = await loadActiveSession(orm(), req, workspace.id);
      req.maskPii = session.maskPii;
      await auditSupport(orm(), req, "support.data_viewed", session, {
        path: String(req.originalUrl ?? "").split("?")[0],
        piiUnmasked: !session.maskPii,
      });
    } else {
      req.maskPii = true;
    }
    return workspace;
  } catch (error) {
    if (error instanceof SupportAccessError) {
      res.status(error.statusCode).json({ code: error.code, message: error.message });
      return null;
    }
    console.error("platform-admin workspace view:", error.message);
    res.status(500).json({ message: "Internal server error while checking workspace" });
    return null;
  }
};

export const getWorkspaceDashboard = async (req, res) => {
  try {
    const workspace = await commonChecks(req, res);
    if (!workspace) return;
    // const reason = String(req.query.reason ?? "").trim();
    // if (reason.length < 5) {
    //   return res.status(400).json({
    //     message: "Provide a reason of at least 5 characters.",
    //   });
    // }

    // await writeAudit(orm(), {
    //   workspaceId: workspace.id,
    //   actorType: "platform_admin",
    //   actorUserId: req.user.id,
    //   action: "admin.workspace_dashboard_viewed",
    //   targetType: "workspace",
    //   targetId: workspace.id,
    //   reason,
    //   ip: req.ip ?? null,
    //   userAgent: req.headers["user-agent"] ?? null,
    // });

    return await getDashboardOverview(req, res, workspace.id);
  } catch (error) {
    console.error("getWorkspaceDashboard:", error.message);
    return res.status(500).json({
      message: "Could not load workspace dashboard.",
    });
  }
};

export const listCustomerView = async (req, res) => {
  try {
    const workspace = await commonChecks(req, res);
    if (!workspace) return;
    return await listCustomers(req, res, workspace.id);
  } catch (error) {
    console.error("getCustomerReport:", error.message);
    return res.status(500).json({
      message: "Could not load customer reports.",
    });
  }
}

export const getSummaryReportView = async (req, res) => {
  try {
    const workspace = await commonChecks(req, res);
    if (!workspace) return;
    return await getSummaryReport(req, res, workspace.id);
  } catch (error) {
    console.error("getSummaryReport:", error.message);
    return res.status(500).json({
      message: "Could not get summary report.",
    });
  }
}

export const getCampaignsReportView = async (req, res) => {
  try {
    const workspace = await commonChecks(req, res);
    if (!workspace) return;
    return await getCampaignsReport(req, res, workspace.id);
  } catch (error) {
    console.error("getCampaignsReport:", error.message);
    return res.status(500).json({
      message: "Could not get campaigns report.",
    });
  }
}

export const getChannelsReportView = async (req, res) => {
  try {
    const workspace = await commonChecks(req, res);
    if (!workspace) return;
    return await getChannelsReport(req, res, workspace.id);
  } catch (error) {
    console.error("getChannelsReport:", error.message);
    return res.status(500).json({
      message: "Could not get channels report.",
    });
  }
}

export const getTrendReportView = async (req, res) => {
  try {
    const workspace = await commonChecks(req, res);
    if (!workspace) return;
    return await getTrendReport(req, res, workspace.id);
  } catch (error) {
    console.error("getTrendReport:", error.message);
    return res.status(500).json({
      message: "Could not get trend report.",
    });
  }
}

export const getLocationsReportView = async (req, res) => {
  try {
    const workspace = await commonChecks(req, res);
    if (!workspace) return;
    return await getLocationsReport(req, res, workspace.id);
  } catch (error) {
    console.error("getLocationReport:", error.message);
    return res.status(500).json({
      message: "Could not get location report.",
    });
  }
}

export const getCustomerReportView = async (req, res) => {
  try {
    const workspace = await commonChecks(req, res);
    if (!workspace) return;
    return await getCustomersReport(req, res, workspace.id);
  } catch (error) {
    console.error("getCustomersReport:", error.message);
    return res.status(500).json({
      message: "Could not get customers report.",
    });
  }
}
