/**
 * Orders & conversions — POST /v1/orders (alias /v1/conversions) | PATCH /v1/orders/:id
 *                        GET /v1/orders | GET /v1/orders/:id/attribution
 *
 * Writes go through services/ingestion.js (the one pipeline shared with connectors and replay).
 *
 * POST body (amounts in major units, or `<name>MinorUnits` integers):
 *   externalId*        your order id (deduplicated per company)
 *   orderedAt*         ISO timestamp the order was paid
 *   currency*          ISO 4217
 *   grossAmount*       total before discounts, excluding tax (send taxIncluded: true if it includes tax)
 *   discountAmount?    discounts (if omitted and netAmount is sent, discount = gross - net)
 *   netAmount?         gross - discount (informational)
 *   taxAmount?         tax
 *   status?            paid (default) | pending | voided
 *   checkoutToken?     token from POST /v1/checkout-sessions (strongest match)
 *   bookingId? / bookingExternalId?   the booking this invoice pays: credit carries forward
 *   email? phone? customerExternalId? customerExternalIdKey?   identity
 *   visitorId?         SDK visitor id      gclid? fbclid? ttclid? msclkid?   click ids
 *   locationId? / locationExternalId?   items?: [{ name, quantity, unitAmount, currency?, externalId? }]
 */

import { db } from "../src/prisma/db.js";
import { tenantDb } from "../services/tenantDb.js";
import { ingestOrder, updateOrderRecord } from "../services/ingestion.js";
import { resolveListWindow } from "./reportsController.js";
import { sendError, wantsCsv, sendCsv, paginate, sortDesc } from "../services/http.js";
import { ATTRIBUTION_MODELS, DEFAULT_MODEL } from "../services/attributionEngine.js";
import { decryptSecret } from "../utils/crypto.js";
import { allowedLocationFilter } from "../services/metrics.js";

const ingestCtx = (req) => ({
    connectorId: req.connector?.id ?? null,
    connectorType: req.connector?.type ?? null,
    receivedAt: req.receivedAt ?? null,
    isTest: req.apiKey?.mode === "test" || Boolean(req.isTest),
});

export const createOrder = async (req, res) => {
    try {
        const result = await ingestOrder(req.workspaceId, req.body ?? {}, ingestCtx(req));
        return res.status(result.statusCode).json(result.body);
    } catch (error) {
        return sendError(res, error, "createOrder");
    }
};

export const updateOrder = async (req, res) => {
    try {
        const result = await updateOrderRecord(req.workspaceId, req.params.id, req.body ?? {}, ingestCtx(req));
        return res.status(result.statusCode).json(result.body);
    } catch (error) {
        return sendError(res, error, "updateOrder");
    }
};

/** Primary source of an order under a model: the channel holding the largest credit. */
export function primarySource(credits) {
    if (!credits?.length) return { channel: "direct_unknown", campaign: null };
    const best = [...credits].sort((a, b) => Number(BigInt(b.amountMinorUnits ?? 0) - BigInt(a.amountMinorUnits ?? 0)) || Number(b.share) - Number(a.share))[0];
    return { channel: best.channel ?? (best.touchId ? "direct" : "direct_unknown"), campaign: best.campaign ?? null, reasonCode: best.reasonCode ?? null };
}

const resolveWorkspace = (req) => req.workspaceId || req.user?.workspaceId || req.params?.workspaceId;

/**
 * GET /v1/orders — every order with its source under the selected model.
 * Filters: from, to (company-local days), tz, model, locationId, channel, status, customerId,
 *          newVsReturning=new|returning, refunded=true, unattributed=true, matchMethod, search (external id),
 *          includeTest=true. Pagination: cursor or page + limit. format=csv exports every matching row.
 */
export const listOrders = async (req, res) => {
    try {
        const workspaceId = resolveWorkspace(req);
        const t = tenantDb(db, workspaceId);
        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
        const model = ATTRIBUTION_MODELS.includes(req.query.model) ? req.query.model : workspace?.defaultModel || DEFAULT_MODEL;

        let query = t.Order.where((o) => o.workspaceId.eq(workspaceId));
        const { fromIso, toIso } = await resolveListWindow(req, workspaceId);
        if (fromIso) query = query.where((o) => o.orderedAt.gte(fromIso));
        if (toIso) query = query.where((o) => o.orderedAt.lte(toIso));
        let orders = await query.all();

        const q = req.query;
        const allowedLocs = allowedLocationFilter(req);
        if (allowedLocs) orders = orders.filter((o) => allowedLocs.has(o.locationId));
        if (q.includeTest !== "true") orders = orders.filter((o) => !o.isTest);
        if (q.status) orders = orders.filter((o) => o.status === q.status);
        if (q.locationId) orders = orders.filter((o) => o.locationId === q.locationId);
        if (q.customerId) orders = orders.filter((o) => o.customerId === q.customerId);
        if (q.matchMethod) orders = orders.filter((o) => o.matchMethod === q.matchMethod);
        if (q.newVsReturning === "new") orders = orders.filter((o) => o.customerId && o.isNewCustomer);
        if (q.newVsReturning === "returning") orders = orders.filter((o) => o.customerId && !o.isNewCustomer);
        if (q.refunded === "true") orders = orders.filter((o) => BigInt(o.refundedMinorUnits ?? 0) > 0n);
        if (q.unattributed === "true") orders = orders.filter((o) => o.matchMethod === "none");
        if (q.search) {
            const s = String(q.search).toLowerCase();
            orders = orders.filter((o) => String(o.externalId ?? "").toLowerCase().includes(s) || o.id === q.search);
        }

        // credits under the selected model, for the source column and the channel filter
        const credits = orders.length ? await t.AttributionCredit.where({ model }).all() : [];
        const byOrder = new Map();
        for (const c of credits) {
            if (!c.orderId) continue;
            if (!byOrder.has(c.orderId)) byOrder.set(c.orderId, []);
            byOrder.get(c.orderId).push(c);
        }
        if (q.channel) orders = orders.filter((o) => (byOrder.get(o.id) ?? []).some((c) => (c.channel ?? "direct_unknown") === q.channel));
        if (q.campaign) orders = orders.filter((o) => (byOrder.get(o.id) ?? []).some((c) => (c.campaign ?? "(none)") === q.campaign));

        sortDesc(orders, "orderedAt");
        const exporting = wantsCsv(req);
        const { data: pageRows, pagination } = exporting ? { data: orders, pagination: null } : paginate(orders, req, "orderedAt");

        const locations = new Map((await t.Location.all()).map((l) => [l.id, l.name]));
        const custIds = [...new Set(pageRows.map((o) => o.customerId).filter(Boolean))];
        const customers = new Map();
        for (const id of custIds) customers.set(id, await t.Customer.where({ id }).first());
        const showEmail = Boolean(req.user) && !req.maskPii;
        const itemCounts = new Map();
        if (!exporting || pageRows.length <= 5000) {
            for (const o of pageRows) itemCounts.set(o.id, (await db.orm.public.OrderItem.where({ orderId: o.id }).all()).map((i) => i.name));
        }

        const data = pageRows.map((o) => {
            const src = primarySource(byOrder.get(o.id));
            const cust = o.customerId ? customers.get(o.customerId) : null;
            const net = BigInt(o.netMinorUnits ?? 0);
            const refunded = BigInt(o.refundedMinorUnits ?? 0);
            return {
                id: o.id,
                externalId: o.externalId,
                status: o.status,
                orderedAt: o.orderedAt,
                createdAt: o.createdAt,
                customerId: o.customerId,
                customerEmail: showEmail && cust?.emailEnc ? decryptSecret(cust.emailEnc) : null,
                locationId: o.locationId,
                locationName: o.locationId ? locations.get(o.locationId) ?? null : null,
                items: itemCounts.get(o.id) ?? [],
                currency: o.currency,
                grossMinorUnits: o.grossMinorUnits?.toString(),
                discountMinorUnits: o.discountMinorUnits?.toString(),
                taxMinorUnits: o.taxMinorUnits?.toString(),
                netMinorUnits: net.toString(),
                refundedMinorUnits: refunded.toString(),
                netAfterRefundsMinorUnits: (net - refunded).toString(),
                fxRateToReporting: o.fxRateToReporting ?? null,
                source: src.channel,
                campaign: src.campaign,
                model,
                matchMethod: o.matchMethod,
                attributionReason: o.attributionReason ?? null,
                isNewCustomer: o.isNewCustomer,
                customerType: o.customerId ? (o.isNewCustomer ? "new" : "returning") : "unknown",
                bookingId: o.bookingId ?? null,
                isTest: Boolean(o.isTest),
            };
        });

        if (exporting) {
            return sendCsv(res, `orders-${model}.csv`, data, [
                "orderedAt", "externalId", "status", "customerId", "customerEmail", "locationName",
                { key: "items", label: "items", value: (r) => r.items.join("; ") },
                "currency", "grossMinorUnits", "discountMinorUnits", "taxMinorUnits", "netMinorUnits", "refundedMinorUnits",
                "source", "campaign", "matchMethod", "attributionReason", "customerType", "model",
            ]);
        }
        return res.status(200).json({ model, data, pagination, lastUpdated: new Date().toISOString() });
    } catch (error) {
        return sendError(res, error, "listOrders");
    }
};

/**
 * GET /v1/orders/:id/attribution — the journey plus the credit under EVERY model, side by side.
 */
export const getOrderAttribution = async (req, res) => {
    try {
        const workspaceId = resolveWorkspace(req);
        const t = tenantDb(db, workspaceId);
        const order = await t.Order.where({ id: req.params.id }).first().catch(() => null);
        if (!order) return res.status(404).json({ message: "Order not found", code: "not_found" });

        const [credits, refunds, items] = await Promise.all([
            t.AttributionCredit.where({ orderId: order.id }).all(),
            t.Refund.where({ orderId: order.id }).all(),
            db.orm.public.OrderItem.where({ orderId: order.id }).all(),
        ]);
        const touchIds = [...new Set(credits.map((c) => c.touchId).filter(Boolean))];
        const touches = [];
        for (const id of touchIds) {
            const touch = await t.Touch.where({ id }).first();
            if (touch) touches.push(touch);
        }
        touches.sort((a, b) => new Date(a.touchedAt) - new Date(b.touchedAt));

        const byModel = {};
        for (const model of ATTRIBUTION_MODELS) byModel[model] = [];
        for (const c of credits) {
            (byModel[c.model] ??= []).push({
                id: c.id,
                attributionCreditId: c.id,
                touchId: c.touchId,
                channel: c.channel ?? (c.touchId ? null : "direct_unknown"),
                campaign: c.campaign ?? null,
                share: Number(c.share),
                amountMinorUnits: c.amountMinorUnits?.toString(),
                currency: c.currency,
                reasonCode: c.reasonCode ?? null,
            });
        }

        return res.status(200).json({
            orderId: order.id,
            externalId: order.externalId,
            status: order.status,
            orderedAt: order.orderedAt,
            currency: order.currency,
            netMinorUnits: order.netMinorUnits?.toString(),
            refundedMinorUnits: order.refundedMinorUnits?.toString(),
            matchMethod: order.matchMethod,
            attributionReason: order.attributionReason ?? null,
            isNewCustomer: order.isNewCustomer,
            bookingId: order.bookingId ?? null,
            items: items.map((i) => ({ name: i.name, quantity: i.quantity, totalMinorUnits: i.totalMinorUnits?.toString(), currency: i.currency })),
            journey: touches.map((x) => ({
                id: x.id,
                touchedAt: x.touchedAt,
                channel: x.channel,
                source: x.source,
                medium: x.medium,
                campaign: x.campaign,
                referrer: x.referrer,
                landingPage: x.landingPage,
                clickId: x.gclid ? "gclid" : x.fbclid ? "fbclid" : x.ttclid ? "ttclid" : x.msclkid ? "msclkid" : null,
            })),
            refunds: refunds.map((r) => ({ id: r.id, amountMinorUnits: r.amountMinorUnits?.toString(), currency: r.currency, refundedAt: r.refundedAt, reason: r.reason })),
            attribution: byModel,
        });
    } catch (error) {
        return sendError(res, error, "getOrderAttribution");
    }
};
