/**
 * Refunds — POST /v1/refunds (secret key only)
 *
 * Records a refund on its own date, linked to the original order (section 6: "Refunds reduce revenue
 * on the date of the refund"). Attributed revenue is reduced with the original order's credit shares
 * under every model (see services/metrics.js).
 *
 * Body: orderId* | externalOrderId*, amount* (major units) | amountMinorUnits, currency* (must match
 *       the order), externalId? (dedup), refundedAt?, reason?, idempotencyKey?
 * Errors: 404 order_not_found (connectors retry automatically), 400 refund_exceeds_order.
 */

import { db } from "../src/prisma/db.js";
import { tenantDb } from "../services/tenantDb.js";
import { ingestRefund } from "../services/ingestion.js";
import { sendError, wantsCsv, sendCsv, paginate, sortDesc } from "../services/http.js";
import { ATTRIBUTION_MODELS, DEFAULT_MODEL } from "../services/attributionEngine.js";
import { allowedLocationFilter, makeConverter, fxSummary } from "../services/metrics.js";
import { resolveListWindow } from "./reportsController.js";
import { primarySource } from "./orderController.js";

export const createRefund = async (req, res) => {
    try {
        const result = await ingestRefund(req.workspaceId, req.body ?? {}, {
            receivedAt: req.receivedAt ?? null,
            isTest: req.apiKey?.mode === "test",
        });
        return res.status(result.statusCode).json(result.body);
    } catch (error) {
        return sendError(res, error, "createRefund");
    }
};

/**
 * GET /v1/refunds (also /api/workspace/refunds and the platform-admin view)
 * Every refund, on its own date, with the order it belongs to and that order's main source.
 * Filters: from, to (company-local days, by refund date), tz, model, locationId, channel, orderId,
 *          search (refund or order external id), includeTest=true. Pagination as /v1/orders; format=csv.
 */
export const listRefunds = async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.user?.workspaceId || req.params?.workspaceId;
        const t = tenantDb(db, workspaceId);
        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
        const model = ATTRIBUTION_MODELS.includes(req.query.model) ? req.query.model : workspace?.defaultModel || DEFAULT_MODEL;

        let query = t.Refund.where((r) => r.workspaceId.eq(workspaceId));
        const { fromIso, toIso } = await resolveListWindow(req, workspaceId);
        if (fromIso) query = query.where((r) => r.refundedAt.gte(fromIso));
        if (toIso) query = query.where((r) => r.refundedAt.lte(toIso));
        let refunds = await query.all();
        const q = req.query;
        if (q.orderId) refunds = refunds.filter((r) => r.orderId === q.orderId);

        const orders = new Map();
        for (const id of new Set(refunds.map((r) => r.orderId))) orders.set(id, await t.Order.where({ id }).first());
        const allowedLocs = allowedLocationFilter(req);
        refunds = refunds.filter((r) => {
            const o = orders.get(r.orderId);
            if (!o) return false;
            if (q.includeTest !== "true" && o.isTest) return false;
            if (allowedLocs && !allowedLocs.has(o.locationId)) return false;
            if (q.locationId && o.locationId !== q.locationId) return false;
            return true;
        });
        if (q.search) {
            const s = String(q.search).toLowerCase();
            refunds = refunds.filter((r) => String(r.externalId ?? "").toLowerCase().includes(s) || String(orders.get(r.orderId)?.externalId ?? "").toLowerCase().includes(s));
        }

        const credits = refunds.length ? await t.AttributionCredit.where({ model }).all() : [];
        const byOrder = new Map();
        for (const c of credits) {
            if (!c.orderId || !orders.has(c.orderId)) continue;
            if (!byOrder.has(c.orderId)) byOrder.set(c.orderId, []);
            byOrder.get(c.orderId).push(c);
        }
        if (q.channel) refunds = refunds.filter((r) => (byOrder.get(r.orderId) ?? []).some((c) => (c.channel ?? "direct_unknown") === q.channel));

        sortDesc(refunds, "refundedAt");
        const exporting = wantsCsv(req);
        const { data: pageRows, pagination } = exporting ? { data: refunds, pagination: null } : paginate(refunds, req, "refundedAt");
        const locations = new Map((await t.Location.all()).map((l) => [l.id, l.name]));

        // total in the reporting currency: each refund at its order's rate (or the latest rate), like the reports
        // ?currency=USD shows the figures in another currency (the viewer's choice); default: reporting currency
        const reporting = /^[A-Za-z]{3}$/.test(String(req.query.currency ?? "")) ? String(req.query.currency).toUpperCase() : workspace?.reportingCurrency || "USD";
        const fxMode = ["transaction_date", "latest"].includes(req.query.fxMode) ? req.query.fxMode : workspace?.fxRateMode || "transaction_date";
        const convert = makeConverter(db, reporting, fxMode);
        const reportingAmount = new Map();
        let totalMinor = 0n;
        let missingFx = 0;
        for (const r of refunds) {
            const o = orders.get(r.orderId);
            const v = await convert(r.amountMinorUnits, r.currency || o?.currency || reporting, String(o?.orderedAt ?? r.refundedAt).slice(0, 10), o?.fxRateToReporting, o?.reportingCurrency);
            reportingAmount.set(r.id, v);
            if (v === null) missingFx++;
            else totalMinor += v;
        }

        const data = pageRows.map((r) => {
            const o = orders.get(r.orderId);
            const src = primarySource(byOrder.get(r.orderId));
            return {
                id: r.id,
                externalId: r.externalId ?? null,
                refundedAt: r.refundedAt,
                amountMinorUnits: BigInt(r.amountMinorUnits ?? 0).toString(),
                currency: r.currency,
                reportingAmountMinorUnits: reportingAmount.get(r.id)?.toString() ?? null,
                reason: r.reason ?? null,
                orderId: r.orderId,
                orderExternalId: o?.externalId ?? null,
                orderedAt: o?.orderedAt ?? null,
                orderNetMinorUnits: o?.netMinorUnits?.toString() ?? null,
                customerId: o?.customerId ?? null,
                locationId: o?.locationId ?? null,
                locationName: o?.locationId ? locations.get(o.locationId) ?? null : null,
                source: src.channel,
                campaign: src.campaign,
                model,
            };
        });

        if (exporting) {
            return sendCsv(res, `refunds-${model}.csv`, data, [
                "refundedAt", "externalId", "amountMinorUnits", "currency", "reason", "orderExternalId", "orderedAt",
                "orderNetMinorUnits", "customerId", "locationName", "source", "campaign", "model",
            ]);
        }
        return res.status(200).json({ model, data, pagination, totals: { refunds: refunds.length, amountMinorUnits: totalMinor.toString(), currency: reporting, missingFx }, fx: fxSummary(convert, reporting), lastUpdated: new Date().toISOString() });
    } catch (error) {
        return sendError(res, error, "listRefunds");
    }
};
