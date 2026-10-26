/**
 * Customers — GET /v1/customers | GET /v1/customers/:id/journey | POST /api/workspace/customers/merge
 *
 * The list (5.5) is searchable and sortable: first seen, first purchase, last purchase, orders,
 * lifetime revenue, first source and last source. The journey (5.3) is the full timeline: touches,
 * bookings, orders, refunds, and the credit each source received. Emails are shown only to logged-in
 * company users (never to API keys) and are masked inside platform-admin support sessions.
 */

import { db } from "../src/prisma/db.js";
import { tenantDb } from "../services/tenantDb.js";
import { decryptSecret } from "../utils/crypto.js";
import { MergeError, mergeCustomers, PAID_ORDER_STATUSES } from "../services/customerMerge.js";
import { keyedHash, hashIdentifier, normalizeEmail } from "../services/identityService.js";
import { ATTRIBUTION_MODELS, DEFAULT_MODEL, UNATTRIBUTED_CHANNEL } from "../services/attributionEngine.js";
import { sendError, wantsCsv, sendCsv, paginate } from "../services/http.js";
import { reattribute } from "../services/ingestion.js";
import { enqueueJob } from "../services/jobs.js";
import { allowedLocationFilter } from "../services/metrics.js";
import { requestRebuild } from "../services/rollups.js";

const workspaceIdOf = (req, WID) => (typeof WID === "string" ? WID : null) || req.workspaceId || req.user?.workspaceId || req.params?.workspaceId;
const showEmail = (req) => Boolean(req.user) && !req.apiKey && !req.maskPii;

const SORTS = {
    firstSeenAt: (c) => c.firstSeenAt ?? "",
    firstPurchaseAt: (c) => c.firstPurchaseAt ?? "",
    lastPurchaseAt: (c) => c.lastPurchaseAt ?? "",
    orders: (c) => c.orders,
    lifetimeRevenue: (c) => Number(c.lifetimeRevenueMinorUnits),
};

/**
 * GET /v1/customers
 * Query: search (email — exact, id, or external id), sort (firstSeenAt | firstPurchaseAt | lastPurchaseAt |
 *        orders | lifetimeRevenue), order (asc | desc), type (new | returning | prospect), model (for sources),
 *        externalId + externalIdKey, page/limit or cursor, format=csv
 */
export const listCustomers = async (req, res, WID) => {
    try {
        const workspaceId = workspaceIdOf(req, WID);
        const t = tenantDb(db, workspaceId);
        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
        const model = ATTRIBUTION_MODELS.includes(req.query.model) ? req.query.model : workspace?.defaultModel || DEFAULT_MODEL;

        let customers = (await t.Customer.where((c) => c.mergedIntoId.isNull()).all()).filter((c) => !c.erasedAt);
        const q = req.query;

        if (q.externalId && q.externalIdKey) customers = customers.filter((c) => (c.externalIds ?? {})[q.externalIdKey] === q.externalId);
        if (q.search) {
            const term = String(q.search).trim();
            const email = normalizeEmail(term);
            if (email) {
                const hashes = new Set([keyedHash(email, workspaceId), hashIdentifier(email)]);
                customers = customers.filter((c) => hashes.has(c.emailHash));
            } else {
                const lower = term.toLowerCase();
                customers = customers.filter((c) => c.id === term || Object.values(c.externalIds ?? {}).some((v) => String(v).toLowerCase().includes(lower)));
            }
        }

        // aggregates from paid orders + first/last source under the selected model
        const orders = (await t.Order.all()).filter((o) => PAID_ORDER_STATUSES.includes(o.status) && !o.isTest);
        const allowedLocs = allowedLocationFilter(req);
        const ordersBy = new Map();
        for (const o of orders) {
            if (!o.customerId || (allowedLocs && !allowedLocs.has(o.locationId))) continue;
            (ordersBy.get(o.customerId) ?? ordersBy.set(o.customerId, []).get(o.customerId)).push(o);
        }
        if (allowedLocs) customers = customers.filter((c) => ordersBy.has(c.id));
        const credits = await t.AttributionCredit.where({ model }).all();
        const creditsBy = new Map();
        for (const c of credits) if (c.orderId) (creditsBy.get(c.orderId) ?? creditsBy.set(c.orderId, []).get(c.orderId)).push(c);
        const sourceOf = (order) => {
            if (!order) return null;
            const best = [...(creditsBy.get(order.id) ?? [])].sort((a, b) => Number(BigInt(b.amountMinorUnits ?? 0) - BigInt(a.amountMinorUnits ?? 0)))[0];
            return best?.channel ?? UNATTRIBUTED_CHANNEL;
        };

        let rows = customers.map((c) => {
            const list = (ordersBy.get(c.id) ?? []).sort((a, b) => new Date(a.orderedAt) - new Date(b.orderedAt));
            const revenue = list.reduce((s, o) => s + BigInt(o.netMinorUnits ?? 0) - BigInt(o.refundedMinorUnits ?? 0), 0n);
            return {
                id: c.id,
                ...(showEmail(req) ? { email: c.emailEnc ? decryptSecret(c.emailEnc) : null } : {}),
                hasEmail: Boolean(c.emailHash),
                hasPhone: Boolean(c.phoneHash),
                firstSeenAt: c.firstSeenAt,
                firstPurchaseAt: c.firstPurchaseAt ?? null,
                lastPurchaseAt: c.lastPurchaseAt ?? null,
                orders: list.length,
                lifetimeRevenueMinorUnits: revenue.toString(),
                currency: list[0]?.currency ?? workspace?.reportingCurrency ?? null,
                firstSource: sourceOf(list[0]),
                lastSource: sourceOf(list[list.length - 1]),
                type: list.length === 0 ? "prospect" : list.length === 1 ? "new" : "returning",
                externalIds: c.externalIds ?? null,
            };
        });
        if (q.type) rows = rows.filter((r) => r.type === q.type);

        const sortKey = SORTS[q.sort] ? q.sort : "firstSeenAt";
        const dir = q.order === "asc" ? 1 : -1;
        rows.sort((a, b) => {
            const x = SORTS[sortKey](a);
            const y = SORTS[sortKey](b);
            return (x > y ? 1 : x < y ? -1 : String(a.id).localeCompare(String(b.id))) * dir;
        });

        if (wantsCsv(req)) {
            return sendCsv(res, "customers.csv", rows, ["id", ...(showEmail(req) ? ["email"] : []), "firstSeenAt", "firstPurchaseAt", "lastPurchaseAt", "orders", "lifetimeRevenueMinorUnits", "currency", "firstSource", "lastSource", "type"]);
        }
        // the list is sorted by the chosen column; paginate keeps that order (cursor by position key)
        const keyed = rows.map((r, i) => ({ ...r, _k: String(rows.length - i).padStart(10, "0") }));
        const page = paginate(keyed, req, "_k");
        page.data = page.data.map(({ _k, ...r }) => r);
        return res.status(200).json({ model, ...page, lastUpdated: new Date().toISOString() });
    } catch (error) {
        return sendError(res, error, "listCustomers");
    }
};

/**
 * GET /v1/customers/:id/journey?model=
 * Timeline (oldest first) of touches, bookings, orders and refunds, the credit each source received
 * under the selected model, and the same totals under every model.
 */
export const getCustomerJourney = async (req, res, WID) => {
    try {
        const workspaceId = workspaceIdOf(req, WID);
        if (!workspaceId) return res.status(400).json({ message: "Company context is required", code: "validation_error" });
        const t = tenantDb(db, workspaceId);
        let customer = await t.Customer.where({ id: req.params.id }).first().catch(() => null);
        if (!customer) return res.status(404).json({ message: "Customer not found", code: "not_found" });
        if (customer.mergedIntoId) customer = (await t.Customer.where({ id: customer.mergedIntoId }).first()) ?? customer;
        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
        const model = ATTRIBUTION_MODELS.includes(req.query.model) ? req.query.model : workspace?.defaultModel || DEFAULT_MODEL;

        const visitors = await t.Visitor.where({ customerId: customer.id }).all();
        const touches = [];
        for (const v of visitors) touches.push(...(await t.Touch.where({ visitorId: v.id }).all()));
        touches.sort((a, b) => String(a.touchedAt).localeCompare(String(b.touchedAt)));
        const orders = await t.Order.where({ customerId: customer.id }).all();
        const bookings = await t.Booking.where({ customerId: customer.id }).all();
        const refunds = [];
        for (const o of orders) refunds.push(...(await t.Refund.where({ orderId: o.id }).all()));

        const allCredits = [];
        for (const o of orders) allCredits.push(...(await t.AttributionCredit.where({ orderId: o.id }).all()));
        for (const b of bookings) allCredits.push(...(await t.AttributionCredit.where({ bookingId: b.id }).all()));
        const credit = (c) => ({ touchId: c.touchId, channel: c.channel ?? (c.touchId ? "direct" : UNATTRIBUTED_CHANNEL), campaign: c.campaign ?? null, share: Number(c.share), amountMinorUnits: c.amountMinorUnits?.toString(), reasonCode: c.reasonCode ?? null });

        const bySourceAllModels = {};
        for (const m of ATTRIBUTION_MODELS) {
            const map = {};
            for (const c of allCredits.filter((x) => x.model === m && x.orderId)) {
                const ch = c.channel ?? (c.touchId ? "direct" : UNATTRIBUTED_CHANNEL);
                map[ch] = (BigInt(map[ch] ?? 0) + BigInt(c.amountMinorUnits ?? 0)).toString();
            }
            bySourceAllModels[m] = map;
        }

        const timeline = [
            ...touches.map((x) => ({ type: "touch", at: x.touchedAt, id: x.id, channel: x.channel, source: x.source, medium: x.medium, campaign: x.campaign, referrer: x.referrer, landingPage: x.landingPage, clickId: x.gclid ? "gclid" : x.fbclid ? "fbclid" : x.ttclid ? "ttclid" : x.msclkid ? "msclkid" : null })),
            ...bookings.map((b) => ({ type: "booking", at: b.bookedAt ?? b.createdAt, id: b.id, externalId: b.externalId, status: b.status, serviceName: b.serviceName, appointmentStartAt: b.appointmentStartAt, bookedValueMinorUnits: b.bookedValueMinorUnits?.toString(), currency: b.currency, matchMethod: b.matchMethod, credits: allCredits.filter((c) => c.bookingId === b.id && c.model === model).map(credit) })),
            ...orders.map((o) => ({ type: "order", at: o.orderedAt, id: o.id, externalId: o.externalId, status: o.status, netMinorUnits: o.netMinorUnits?.toString(), currency: o.currency, matchMethod: o.matchMethod, attributionReason: o.attributionReason ?? null, isNewCustomer: o.isNewCustomer, bookingId: o.bookingId ?? null, credits: allCredits.filter((c) => c.orderId === o.id && c.model === model).map(credit) })),
            ...refunds.map((r) => ({ type: "refund", at: r.refundedAt, id: r.id, orderId: r.orderId, amountMinorUnits: r.amountMinorUnits?.toString(), currency: r.currency, reason: r.reason })),
        ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

        return res.status(200).json({
            customer: {
                id: customer.id,
                ...(showEmail(req) ? { email: customer.emailEnc ? decryptSecret(customer.emailEnc) : null } : {}),
                firstSeenAt: customer.firstSeenAt,
                firstPurchaseAt: customer.firstPurchaseAt ?? null,
                lastPurchaseAt: customer.lastPurchaseAt ?? null,
                externalIds: customer.externalIds ?? null,
                devices: visitors.length,
            },
            attributionModel: model,
            timeline,
            creditBySource: bySourceAllModels[model],
            creditBySourceAllModels: bySourceAllModels,
            // legacy shape (kept for existing integrations)
            touches: timeline.filter((e) => e.type === "touch").map(({ type, at, ...x }) => ({ ...x, touchedAt: at })),
            orders: timeline.filter((e) => e.type === "order").map(({ type, at, ...x }) => ({ ...x, orderedAt: at })),
            bookings: timeline.filter((e) => e.type === "booking").map(({ type, ...x }) => x),
            refunds: timeline.filter((e) => e.type === "refund").map(({ type, at, ...x }) => ({ ...x, refundedAt: at })),
            touchCount: touches.length,
        });
    } catch (error) {
        return sendError(res, error, "getCustomerJourney");
    }
};

/**
 * POST /api/workspace/customers/merge   (company_admin)   Body: { sourceId, targetId }
 * Touches (through visitors), orders and bookings move to the target, new-vs-returning is recomputed and
 * attribution is recomputed for the combined history (scope 4.5).
 */
export const mergeCustomersHandler = async (req, res) => {
    try {
        const { sourceId, targetId } = req.body ?? {};
        const workspaceId = req.user.workspaceId;
        const result = await mergeCustomers(db, { workspaceId, sourceId, targetId, actorUserId: req.user.id, ip: req.ip, userAgent: req.headers["user-agent"] });
        // the target now has more visitors (and so more touches): re-attribute its history
        const reattributed = await reattributeCustomer(workspaceId, result.targetId);
        return res.status(200).json({ ...result, reattributed });
    } catch (error) {
        if (error instanceof MergeError) return res.status(error.statusCode).json({ code: error.code, message: error.message });
        return sendError(res, error, "mergeCustomers");
    }
};

/**
 * Re-attribute one customer's bookings then orders. The merge itself is already committed, so a
 * failure here falls back to a background re-run instead of failing the request.
 */
async function reattributeCustomer(workspaceId, customerId) {
    const t = tenantDb(db, workspaceId);
    let count = 0;
    try {
        for (const b of await t.Booking.where({ customerId }).all()) {
            await reattribute(workspaceId, { bookingId: b.id });
            count++;
        }
        for (const o of await t.Order.where({ customerId }).all()) {
            await reattribute(workspaceId, { orderId: o.id });
            count++;
        }
        await requestRebuild(workspaceId);
    } catch (err) {
        console.error("re-attribution after merge failed, queued a full re-run:", err.message);
        enqueueJob("attribution.rerun", { workspaceId, reason: "customer_merge" });
    }
    return count;
}

async function findByExternal(t, key, value) {
    const all = await t.Customer.where((c) => c.mergedIntoId.isNull()).all();
    return all.find((c) => (c.externalIds ?? {})[key] === String(value)) ?? null;
}

/**
 * POST /v1/customers/merge (secret key) — the source system merged two customers.
 * Body: { sourceId?, targetId? } (our ids) or { sourceExternalId, targetExternalId, externalIdKey }.
 * Same effect as a dashboard merge: history combined, new-vs-returning and attribution recomputed.
 */
export async function mergeFromSource(workspaceId, body, actor = {}) {
    const t = tenantDb(db, workspaceId);
    let { sourceId, targetId } = body ?? {};
    if (!sourceId || !targetId) {
        const key = body?.externalIdKey || "default";
        const source = body?.sourceExternalId ? await findByExternal(t, key, body.sourceExternalId) : null;
        const target = body?.targetExternalId ? await findByExternal(t, key, body.targetExternalId) : null;
        if (!source || !target) throw new MergeError(404, "Customer not found", "not_found");
        sourceId = source.id;
        targetId = target.id;
    }
    const result = await mergeCustomers(db, { workspaceId, sourceId, targetId, actorUserId: actor.userId ?? null, ip: actor.ip ?? null, userAgent: actor.userAgent ?? null });
    return { ...result, reattributed: await reattributeCustomer(workspaceId, result.targetId) };
}

export const mergeCustomersApi = async (req, res) => {
    try {
        return res.status(200).json(await mergeFromSource(req.workspaceId, req.body, { ip: req.ip, userAgent: req.headers?.["user-agent"] }));
    } catch (error) {
        if (error instanceof MergeError) return res.status(error.statusCode).json({ code: error.code, message: error.message });
        return sendError(res, error, "mergeCustomersApi");
    }
};
