import { db } from "../src/prisma/db.js";
import * as reports from "./reportsController.js";
import { listCustomers, getCustomerJourney } from "./customerController.js";
import { listOrders, getOrderAttribution } from "./orderController.js";
import { listRefunds } from "./refundController.js";
import { listBookings, listUpcomingBookings } from "./bookingController.js";

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
    // From here on the handlers are the company's own, scoped to this workspace (read-only routes).
    req.workspaceId = workspace.id;
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

/**
 * Wrap a company read handler for the platform-admin "view as" screens: support session + reason
 * required, every request audited for the company, PII masked unless the session unmasked it.
 */
const view = (handler, label) => async (req, res) => {
  try {
    const workspace = await commonChecks(req, res);
    if (!workspace) return;
    return await handler(req, res, workspace.id);
  } catch (error) {
    console.error(`platform-admin view ${label}:`, error.message);
    return res.status(500).json({ message: `Could not load ${label}.` });
  }
};

export const getWorkspaceDashboard = view(reports.getDashboardOverview, "workspace dashboard");
export const listCustomerView = view(listCustomers, "customers");
export const getCustomerJourneyView = view(getCustomerJourney, "customer journey");
export const getSummaryReportView = view(reports.getSummaryReport, "summary report");
export const getCampaignsReportView = view(reports.getCampaignsReport, "campaigns report");
export const getChannelsReportView = view(reports.getChannelsReport, "channels report");
export const getTrendReportView = view(reports.getTrendReport, "trend report");
export const getLocationsReportView = view(reports.getLocationsReport, "locations report");
export const getCustomerReportView = view(reports.getCustomersReport, "customers report");
export const getCacReportView = view(reports.getCacReport, "CAC report");
export const getSpendReportView = view(reports.getSpendReport, "spend report");
export const getBookingsReportView = view(reports.getBookingsReport, "bookings report");
export const getJourneysReportView = view(reports.getJourneysReport, "journeys report");
export const getCoverageReportView = view(reports.getCoverageReport, "coverage report");
export const getDataQualityReportView = view(reports.getDataQualityReport, "data quality report");
export const getAlertsView = view(reports.getAlerts, "alerts");
export const listTransactionsView = view(listOrders, "transactions");
export const listRefundsView = view(listRefunds, "refunds");
export const getOrderAttributionView = view(getOrderAttribution, "order attribution");
export const listBookingsView = view(listBookings, "bookings");
export const listUpcomingView = view(listUpcomingBookings, "upcoming bookings");
