/**
 * Workspace analytics and report endpoints.
 * Report dates are resolved in the workspace timezone, then credits and transactions are aggregated
 * under the requested attribution model and filters.
 */

/**
 * Reports Controller  —  GET /v1/reports/*
 *
 * High-performance reporting engine with database-level date filtering
 * and batch-loading to eliminate N+1 queries.
 *
 * All reports accept:
 *   from*          - ISO date start (e.g. "2026-01-01")
 *   to*            - ISO date end
 *   model?         - attribution model (default: last_non_direct)
 *   locationId?    - filter to a specific location
 *   currency?      - reporting currency (default: workspace reporting currency)
 *   tz?            - IANA timezone for day boundaries (default: workspace timezone)
 *
 * Auth: API key via apiKeyAuth middleware.
 */

import { db } from "../src/prisma/db.js";
import { resolveDateRange, resolveOpenRange, localDateString } from "../utils/timezone.js";

const DEFAULT_MODEL = "last_non_direct";

/**
 * Resolves query params into a report range in the COMPANY's local timezone.
 *   tz?  IANA timezone; defaults to the workspace timezone (not UTC)
 *   from/to  "YYYY-MM-DD" = whole local days; a full ISO timestamp is used as given
 * Throws RangeInputError (statusCode 400) for invalid input.
 */
export async function parseReportParams(req, workspaceId) {
    const { from, to, model = DEFAULT_MODEL, locationId } = req.query;
    let tz = req.query.tz;
    if (!tz) {
        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
        tz = workspace?.timezone || "UTC";
    }
    const { fromDate, toDate } = resolveDateRange({ from, to, timeZone: tz });
    return { fromDate, toDate, model, locationId: locationId || null, tz };
}

/**
 * Date window for LIST endpoints (orders, bookings), using the same local-day rule as the reports so a
 * drill-down list always adds up to the report total. Ends that were not supplied stay open.
 * @returns {Promise<{fromIso: string|null, toIso: string|null}>}
 */
export async function resolveListWindow(req, workspaceId) {
    const { from, to } = req.query;
    if (!from && !to) return { fromIso: null, toIso: null };
    let tz = req.query.tz;
    if (!tz) {
        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
        tz = workspace?.timezone || "UTC";
    }
    const { fromDate, toDate } = resolveOpenRange({ from, to, timeZone: tz });
    return { fromIso: fromDate ? fromDate.toISOString() : null, toIso: toDate ? toDate.toISOString() : null };
}

/**
 * Helper to build orders query with database-level filters
 */
function buildOrdersQuery(workspaceId, fromDate, toDate, locationId = null) {
    let query = db.orm.public.Order
        .where((o) => o.workspaceId.eq(workspaceId))
        .where((o) => o.status.in(["paid", "partially_refunded"]))
        .where((o) => o.orderedAt.gte(fromDate.toISOString()))
        .where((o) => o.orderedAt.lte(toDate.toISOString()));

    if (locationId) {
        query = query.where((o) => o.locationId.eq(locationId));
    }
    return query;
}

/**
 * GET /v1/reports/summary
 * Overview: revenue, orders, new/returning customers, bookings.
 */
export const getSummaryReport = async (req, res, WID) => {
    try {
        const workspaceId = req.workspaceId || WID;
        const { fromDate, toDate, model, locationId, tz } = await parseReportParams(req, workspaceId);

        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();

        // Database-level filtered queries
        const orders = await buildOrdersQuery(workspaceId, fromDate, toDate, locationId).all();

        const refunds = await db.orm.public.Refund
            .where((r) => r.workspaceId.eq(workspaceId))
            .where((r) => r.refundedAt.gte(fromDate.toISOString()))
            .where((r) => r.refundedAt.lte(toDate.toISOString()))
            .all();

        let bookingQuery = db.orm.public.Booking
            .where((b) => b.workspaceId.eq(workspaceId))
            .where((b) => b.createdAt.gte(fromDate.toISOString()))
            .where((b) => b.createdAt.lte(toDate.toISOString()));

        if (locationId) {
            bookingQuery = bookingQuery.where((b) => b.locationId.eq(locationId));
        }
        const bookings = await bookingQuery.all();

        // Revenue metrics
        const grossRevenue = orders.reduce((s, o) => s + BigInt(o.grossMinorUnits || 0n), 0n);
        const discounts = orders.reduce((s, o) => s + BigInt(o.discountMinorUnits || 0n), 0n);
        const refundTotal = refunds.reduce((s, r) => s + BigInt(r.amountMinorUnits || 0n), 0n);
        const netRevenue = grossRevenue - discounts - refundTotal;

        const orderCount = orders.length;
        const aov = orderCount > 0 ? (netRevenue / BigInt(orderCount)).toString() : "0";

        const newCustomers = orders.filter((o) => o.isNewCustomer).length;
        const returningCustomers = orders.filter((o) => !o.isNewCustomer).length;

        // Attributed revenue: batch query credits to avoid N+1 queries
        let totalCredited = 0n;
        if (orders.length > 0) {
            const orderIdSet = new Set(orders.map((o) => o.id));
            const allCredits = await db.orm.public.AttributionCredit.where({ workspaceId, model }).all();
            const relevantCredits = allCredits.filter((c) => c.orderId && orderIdSet.has(c.orderId) && c.touchId !== null);
            totalCredited = relevantCredits.reduce((s, c) => s + BigInt(c.amountMinorUnits || 0n), 0n);
        }

        const attributionCoverage = netRevenue > 0n
            ? (Number(totalCredited) / Number(netRevenue))
            : 0;

        // Booking metrics
        const scheduledBookings = bookings.filter((b) => ["scheduled", "confirmed"].includes(b.status)).length;
        const cancelledBookings = bookings.filter((b) => b.status === "cancelled").length;
        const bookedValue = bookings.reduce((s, b) => s + BigInt(b.bookedValueMinorUnits || 0n), 0n);

        return res.status(200).json({
            period: { from: fromDate.toISOString(), to: toDate.toISOString(), tz },
            currency: workspace?.reportingCurrency || "USD",
            model,
            revenue: {
                grossMinorUnits: grossRevenue.toString(),
                discountsMinorUnits: discounts.toString(),
                refundsMinorUnits: refundTotal.toString(),
                netMinorUnits: netRevenue.toString(),
                averageOrderValueMinorUnits: aov,
            },
            orders: {
                total: orderCount,
                newCustomers,
                returningCustomers,
            },
            attribution: {
                attributedRevenueMinorUnits: totalCredited.toString(),
                coverageRate: Math.round(attributionCoverage * 10000) / 100, // percentage, 2 decimals
            },
            bookings: {
                total: bookings.length,
                scheduled: scheduledBookings,
                cancelled: cancelledBookings,
                bookedValueMinorUnits: bookedValue.toString(),
                cancellationRate: bookings.length > 0
                    ? Math.round((cancelledBookings / bookings.length) * 10000) / 100
                    : 0,
            },
        });
    } catch (error) {
        if (error?.statusCode === 400) return res.status(400).json({ message: error.message });
        console.error("getSummaryReport error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /v1/reports/channels
 * Revenue and orders broken down by channel.
 */
export const getChannelsReport = async (req, res, WID) => {
    try {
        const workspaceId = req.workspaceId || WID;
        const { fromDate, toDate, model, locationId, tz } = await parseReportParams(req, workspaceId);

        const orders = await buildOrdersQuery(workspaceId, fromDate, toDate, locationId).all();
        if (orders.length === 0) {
            return res.status(200).json({ period: { from: fromDate.toISOString(), to: toDate.toISOString(), tz }, model, data: [] });
        }

        const orderIdSet = new Set(orders.map((o) => o.id));
        const allCredits = await db.orm.public.AttributionCredit.where({ workspaceId, model }).all();
        const relevantCredits = allCredits.filter((c) => c.orderId && orderIdSet.has(c.orderId));

        // Group credits by orderId
        const creditsByOrder = new Map();
        const touchIdsToFetch = new Set();
        for (const c of relevantCredits) {
            if (!creditsByOrder.has(c.orderId)) creditsByOrder.set(c.orderId, []);
            creditsByOrder.get(c.orderId).push(c);
            if (c.touchId) touchIdsToFetch.add(c.touchId);
        }

        // Batch load touches for channel lookup
        const touchMap = new Map();
        if (touchIdsToFetch.size > 0) {
            const allTouches = await db.orm.public.Touch.where({ workspaceId }).all();
            for (const t of allTouches) {
                if (touchIdsToFetch.has(t.id)) touchMap.set(t.id, t);
            }
        }

        const channelMap = {};

        for (const order of orders) {
            const credits = creditsByOrder.get(order.id) || [];
            if (credits.length === 0) {
                // Unattributed
                const ch = "direct_unknown";
                if (!channelMap[ch]) channelMap[ch] = { channel: ch, orders: 0, netMinorUnits: 0n, newCustomers: 0, returningCustomers: 0 };
                channelMap[ch].orders++;
                channelMap[ch].netMinorUnits += BigInt(order.netMinorUnits || 0n);
                if (order.isNewCustomer) channelMap[ch].newCustomers++; else channelMap[ch].returningCustomers++;
                continue;
            }

            for (const credit of credits) {
                let ch = "direct";
                if (credit.touchId && touchMap.has(credit.touchId)) {
                    ch = touchMap.get(credit.touchId).channel || "direct";
                }

                if (!channelMap[ch]) channelMap[ch] = { channel: ch, orders: 0, netMinorUnits: 0n, newCustomers: 0, returningCustomers: 0 };
                channelMap[ch].orders++;
                channelMap[ch].netMinorUnits += BigInt(credit.amountMinorUnits || 0n);
                if (order.isNewCustomer) channelMap[ch].newCustomers++; else channelMap[ch].returningCustomers++;
            }
        }

        const data = Object.values(channelMap).map((c) => ({
            ...c,
            netMinorUnits: c.netMinorUnits.toString(),
        })).sort((a, b) => Number(BigInt(b.netMinorUnits) - BigInt(a.netMinorUnits)));

        return res.status(200).json({ period: { from: fromDate.toISOString(), to: toDate.toISOString(), tz }, model, data });
    } catch (error) {
        if (error?.statusCode === 400) return res.status(400).json({ message: error.message });
        console.error("getChannelsReport error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /v1/reports/campaigns
 * Revenue broken down by campaign.
 */
export const getCampaignsReport = async (req, res, WID) => {
    try {
        const workspaceId = req.workspaceId || WID;
        const { fromDate, toDate, model, locationId, tz } = await parseReportParams(req, workspaceId);

        const orders = await buildOrdersQuery(workspaceId, fromDate, toDate, locationId).all();
        if (orders.length === 0) {
            return res.status(200).json({ period: { from: fromDate.toISOString(), to: toDate.toISOString(), tz }, model, data: [] });
        }

        const orderIdSet = new Set(orders.map((o) => o.id));
        const allCredits = await db.orm.public.AttributionCredit.where({ workspaceId, model }).all();
        const relevantCredits = allCredits.filter((c) => c.orderId && orderIdSet.has(c.orderId));

        const touchIdsToFetch = new Set();
        for (const c of relevantCredits) {
            if (c.touchId) touchIdsToFetch.add(c.touchId);
        }

        const touchMap = new Map();
        if (touchIdsToFetch.size > 0) {
            const allTouches = await db.orm.public.Touch.where({ workspaceId }).all();
            for (const t of allTouches) {
                if (touchIdsToFetch.has(t.id)) touchMap.set(t.id, t);
            }
        }

        const campaignMap = {};

        for (const credit of relevantCredits) {
            let campaign = "(none)";
            let channel = "direct";
            if (credit.touchId && touchMap.has(credit.touchId)) {
                const t = touchMap.get(credit.touchId);
                campaign = t.campaign || "(none)";
                channel = t.channel || "direct";
            }
            const key = `${channel}::${campaign}`;
            if (!campaignMap[key]) campaignMap[key] = { channel, campaign, orders: 0, netMinorUnits: 0n };
            campaignMap[key].orders++;
            campaignMap[key].netMinorUnits += BigInt(credit.amountMinorUnits || 0n);
        }

        const data = Object.values(campaignMap).map((c) => ({
            ...c,
            netMinorUnits: c.netMinorUnits.toString(),
        })).sort((a, b) => Number(BigInt(b.netMinorUnits) - BigInt(a.netMinorUnits)));

        return res.status(200).json({ period: { from: fromDate.toISOString(), to: toDate.toISOString(), tz }, model, data });
    } catch (error) {
        if (error?.statusCode === 400) return res.status(400).json({ message: error.message });
        console.error("getCampaignsReport error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /v1/reports/locations
 * Revenue and orders per location.
 */
export const getLocationsReport = async (req, res, WID) => {
    try {
        const workspaceId = req.workspaceId || WID;
        const { fromDate, toDate, tz } = await parseReportParams(req, workspaceId);

        const locations = await db.orm.public.Location.where({ workspaceId }).all();
        const orders = await buildOrdersQuery(workspaceId, fromDate, toDate).all();

        const data = locations.map((loc) => {
            const locOrders = orders.filter((o) => o.locationId === loc.id);
            const net = locOrders.reduce((s, o) => s + BigInt(o.netMinorUnits || 0n), 0n);
            return {
                locationId: loc.id,
                locationName: loc.name,
                orders: locOrders.length,
                netMinorUnits: net.toString(),
                newCustomers: locOrders.filter((o) => o.isNewCustomer).length,
                returningCustomers: locOrders.filter((o) => !o.isNewCustomer).length,
            };
        }).sort((a, b) => Number(BigInt(b.netMinorUnits) - BigInt(a.netMinorUnits)));

        // Include unassigned orders
        const unassigned = orders.filter((o) => !o.locationId);
        if (unassigned.length > 0) {
            data.push({
                locationId: null,
                locationName: "(No location)",
                orders: unassigned.length,
                netMinorUnits: unassigned.reduce((s, o) => s + BigInt(o.netMinorUnits || 0n), 0n).toString(),
                newCustomers: unassigned.filter((o) => o.isNewCustomer).length,
                returningCustomers: unassigned.filter((o) => !o.isNewCustomer).length,
            });
        }

        return res.status(200).json({ period: { from: fromDate.toISOString(), to: toDate.toISOString(), tz }, data });
    } catch (error) {
        if (error?.statusCode === 400) return res.status(400).json({ message: error.message });
        console.error("getLocationsReport error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /v1/reports/trend
 * Daily revenue trend over the date range.
 */
export const getTrendReport = async (req, res, WID) => {
    try {
        const workspaceId = req.workspaceId || WID;
        const { fromDate, toDate, locationId, tz } = await parseReportParams(req, workspaceId);

        const orders = await buildOrdersQuery(workspaceId, fromDate, toDate, locationId).all();

        // Group by day (ISO date string in specified timezone)
        const dayMap = {};
        for (const order of orders) {
            const d = localDateString(new Date(order.orderedAt), tz); // YYYY-MM-DD in the company timezone
            if (!dayMap[d]) dayMap[d] = { date: d, orders: 0, netMinorUnits: 0n, newCustomers: 0 };
            dayMap[d].orders++;
            dayMap[d].netMinorUnits += BigInt(order.netMinorUnits || 0n);
            if (order.isNewCustomer) dayMap[d].newCustomers++;
        }

        const data = Object.values(dayMap).map((d) => ({
            ...d,
            netMinorUnits: d.netMinorUnits.toString(),
        })).sort((a, b) => a.date.localeCompare(b.date));

        return res.status(200).json({ period: { from: fromDate.toISOString(), to: toDate.toISOString(), tz }, tz, data });
    } catch (error) {
        if (error?.statusCode === 400) return res.status(400).json({ message: error.message });
        console.error("getTrendReport error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /v1/reports/customers
 * New vs returning split, cohort data summary.
 */
export const getCustomersReport = async (req, res, WID) => {
    try {
        const workspaceId = req.workspaceId || WID;
        const { fromDate, toDate, tz } = await parseReportParams(req, workspaceId);

        const customers = await db.orm.public.Customer.where({ workspaceId }).all();
        const inRange = (d) => new Date(d) >= fromDate && new Date(d) <= toDate;

        const newInPeriod = customers.filter((c) => c.firstPurchaseAt && inRange(c.firstPurchaseAt));
        const returningInPeriod = customers.filter((c) =>
            c.firstPurchaseAt && new Date(c.firstPurchaseAt) < fromDate &&
            c.lastPurchaseAt && inRange(c.lastPurchaseAt)
        );

        // Customers with 2+ orders = repeat customers
        const orders = await db.orm.public.Order
            .where((o) => o.workspaceId.eq(workspaceId))
            .where((o) => o.status.eq("paid"))
            .all();

        const ordersByCustomer = {};
        for (const o of orders) {
            if (!o.customerId) continue;
            ordersByCustomer[o.customerId] = (ordersByCustomer[o.customerId] || 0) + 1;
        }
        const repeatCustomers = Object.values(ordersByCustomer).filter((count) => count >= 2).length;
        const totalWithOrders = Object.keys(ordersByCustomer).length;
        const repeatRate = totalWithOrders > 0 ? Math.round((repeatCustomers / totalWithOrders) * 10000) / 100 : 0;

        return res.status(200).json({
            period: { from: fromDate.toISOString(), to: toDate.toISOString(), tz },
            newCustomers: newInPeriod.length,
            returningCustomers: returningInPeriod.length,
            totalCustomers: customers.filter((c) => !c.mergedIntoId).length,
            repeatRate,
        });
    } catch (error) {
        if (error?.statusCode === 400) return res.status(400).json({ message: error.message });
        console.error("getCustomersReport error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /api/workspace/dashboard  |  GET /v1/reports/dashboard
 * All-in-one executive dashboard endpoint tailored for the Elysium frontend layout:
 *   - Primary Revenue (Total, Excl Tax, Tax, Invoices count)
 *   - 4 Primary KPIs (New Customers, Returning, Retention rate, Tracked Visits)
 *   - 4 Revenue Cards (Ad-Attributed, Direct/Organic, Unattributed, Refunded, AOV with % change)
 *   - Revenue by Source (Google %, Direct %, Meta % horizontal bar)
 *   - Revenue by Platform Table (Platform, Conversions, Revenue, badge colors)
 */
export const getDashboardOverview = async (req, res, WID) => {
    try {
        const role = req.user?.role;
        let workspaceId = null;
        if (role === "platform_admin") {
            workspaceId = WID;
        } else {
            // API-key requests carry the workspace in req.workspaceId; dashboard users in their login
            workspaceId = req.workspaceId || req.user?.workspaceId;
        }
        if (!workspaceId) return res.status(401).json({ message: "Workspace id required" });

        const { fromDate, toDate, model, locationId, tz } = await parseReportParams(req, workspaceId);
        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();

        // 1. Current period orders
        const orders = await buildOrdersQuery(workspaceId, fromDate, toDate, locationId).all();

        // 2. Prior period orders for AOV comparison
        const durationMs = toDate.getTime() - fromDate.getTime();
        const priorFromDate = new Date(fromDate.getTime() - durationMs);
        const priorToDate = new Date(fromDate.getTime() - 1);
        const priorOrders = await buildOrdersQuery(workspaceId, priorFromDate, priorToDate, locationId).all();

        // 3. Refunds in period
        const refunds = await db.orm.public.Refund
            .where((r) => r.workspaceId.eq(workspaceId))
            .where((r) => r.refundedAt.gte(fromDate.toISOString()))
            .where((r) => r.refundedAt.lte(toDate.toISOString()))
            .all();

        // 4. Tracked visits (touches in period)
        const touchCountResult = await db.orm.public.Touch
            .where((t) => t.workspaceId.eq(workspaceId))
            .where((t) => t.touchedAt.gte(fromDate.toISOString()))
            .where((t) => t.touchedAt.lte(toDate.toISOString()))
            .aggregate((agg) => ({ total: agg.count() }));
        const trackedVisits = touchCountResult?.total || 0;

        // 5. Customer retention metrics
        const allCustomers = await db.orm.public.Customer
            .where((c) => c.workspaceId.eq(workspaceId))
            .where((c) => c.mergedIntoId.isNull())
            .all();

        const totalCustomersAllTime = allCustomers.length;
        const retainedCustomersAllTime = allCustomers.filter(
            (c) => c.firstPurchaseAt && c.lastPurchaseAt && c.firstPurchaseAt !== c.lastPurchaseAt
        ).length;
        const retentionRate = totalCustomersAllTime > 0
            ? Math.round((retainedCustomersAllTime / totalCustomersAllTime) * 1000) / 10
            : 0;

        // Orders breakdown
        const invoicesCount = orders.length;
        const grossMinor = orders.reduce((s, o) => s + BigInt(o.grossMinorUnits || 0n), 0n);
        const taxMinor = orders.reduce((s, o) => s + BigInt(o.taxMinorUnits || 0n), 0n);
        const discountMinor = orders.reduce((s, o) => s + BigInt(o.discountMinorUnits || 0n), 0n);
        const exclTaxMinor = grossMinor - taxMinor;
        const refundMinor = refunds.reduce((s, r) => s + BigInt(r.amountMinorUnits || 0n), 0n);
        const netMinor = grossMinor - discountMinor - refundMinor;

        const newCustomers = orders.filter((o) => o.isNewCustomer).length;
        const returningCustomers = orders.filter((o) => !o.isNewCustomer).length;

        // Average Order Value
        const aovMinor = invoicesCount > 0 ? Number(netMinor) / invoicesCount : 0;
        const aov = (aovMinor / 100).toFixed(2);

        // Prior AOV & change percentage
        const priorGross = priorOrders.reduce((s, o) => s + BigInt(o.grossMinorUnits || 0n), 0n);
        const priorDiscounts = priorOrders.reduce((s, o) => s + BigInt(o.discountMinorUnits || 0n), 0n);
        const priorNet = priorGross - priorDiscounts;
        const priorAovMinor = priorOrders.length > 0 ? Number(priorNet) / priorOrders.length : 0;
        const aovChangePercent = priorAovMinor > 0
            ? Math.round(((aovMinor - priorAovMinor) / priorAovMinor) * 1000) / 10
            : 0;

        // 6. Attribution breakdown across platforms (Meta, Google, Direct, AWIN, etc.)
        const orderIdSet = new Set(orders.map((o) => o.id));
        const allCredits = await db.orm.public.AttributionCredit.where({ workspaceId, model }).all();
        const relevantCredits = allCredits.filter((c) => c.orderId && orderIdSet.has(c.orderId));

        const touchIdsToFetch = new Set(relevantCredits.filter((c) => c.touchId).map((c) => c.touchId));
        const touchMap = new Map();
        if (touchIdsToFetch.size > 0) {
            const touches = await db.orm.public.Touch.where({ workspaceId }).all();
            for (const t of touches) {
                if (touchIdsToFetch.has(t.id)) touchMap.set(t.id, t);
            }
        }

        const platformMap = {
            Direct: { platform: "Direct", conversions: 0, revenueMinorUnits: 0n, color: "#22c55e", badge: "Direct" },
            Google: { platform: "Google", conversions: 0, revenueMinorUnits: 0n, color: "#3b82f6", badge: "Google" },
            AWIN: { platform: "AWIN", conversions: 0, revenueMinorUnits: 0n, color: "#71717a", badge: "AWIN" },
            META: { platform: "META", conversions: 0, revenueMinorUnits: 0n, color: "#a855f7", badge: "META" },
        };

        const creditsByOrder = new Map();
        for (const c of relevantCredits) {
            if (!creditsByOrder.has(c.orderId)) creditsByOrder.set(c.orderId, []);
            creditsByOrder.get(c.orderId).push(c);
        }

        let adAttributedMinor = 0n;
        let directOrganicMinor = 0n;
        let unattributedMinor = 0n;

        for (const order of orders) {
            const credits = creditsByOrder.get(order.id) || [];
            if (credits.length === 0) {
                platformMap.Direct.conversions++;
                platformMap.Direct.revenueMinorUnits += BigInt(order.netMinorUnits || 0n);
                directOrganicMinor += BigInt(order.netMinorUnits || 0n);
                continue;
            }

            for (const c of credits) {
                let platformKey = "Direct";
                if (c.touchId && touchMap.has(c.touchId)) {
                    const t = touchMap.get(c.touchId);
                    const ch = (t.channel || "").toLowerCase();
                    const src = (t.source || "").toLowerCase();
                    if (src.includes("google") || ch.includes("google") || ch === "paid_search") {
                        platformKey = "Google";
                    } else if (src.includes("meta") || src.includes("facebook") || src.includes("instagram") || ch.includes("meta") || ch === "paid_social") {
                        platformKey = "META";
                    } else if (src.includes("awin") || ch.includes("affiliate")) {
                        platformKey = "AWIN";
                    } else if (ch === "direct" || ch === "organic" || src === "direct") {
                        platformKey = "Direct";
                    } else {
                        platformKey = t.source || t.channel || "Direct";
                    }
                }

                if (!platformMap[platformKey]) {
                    platformMap[platformKey] = {
                        platform: platformKey,
                        conversions: 0,
                        revenueMinorUnits: 0n,
                        color: "#6366f1",
                        badge: platformKey,
                    };
                }

                const amt = BigInt(c.amountMinorUnits || 0n);
                platformMap[platformKey].conversions++;
                platformMap[platformKey].revenueMinorUnits += amt;

                if (["Google", "META", "AWIN"].includes(platformKey) || platformKey.toLowerCase().includes("ad")) {
                    adAttributedMinor += amt;
                } else {
                    directOrganicMinor += amt;
                }
            }
        }

        // Percentage breakdown for top stacked bar
        const totalPlatformRevenue = Object.values(platformMap).reduce((s, p) => s + p.revenueMinorUnits, 0n);
        const revenueBySource = Object.values(platformMap)
            .filter((p) => p.conversions > 0 || p.revenueMinorUnits > 0n)
            .map((p) => ({
                source: p.platform,
                percentage: totalPlatformRevenue > 0n ? Math.round((Number(p.revenueMinorUnits) / Number(totalPlatformRevenue)) * 100) : 0,
                color: p.color,
                revenue: (Number(p.revenueMinorUnits) / 100).toFixed(2),
                conversions: p.conversions,
            }))
            .sort((a, b) => b.percentage - a.percentage);

        // Platform table rows
        const revenueByPlatform = Object.values(platformMap)
            .filter((p) => p.conversions > 0 || p.revenueMinorUnits > 0n)
            .map((p) => ({
                platform: p.platform,
                badge: p.badge,
                conversions: p.conversions,
                revenue: (Number(p.revenueMinorUnits) / 100).toFixed(2),
                revenueMinorUnits: p.revenueMinorUnits.toString(),
                color: p.color,
            }))
            .sort((a, b) => Number(BigInt(b.revenueMinorUnits) - BigInt(a.revenueMinorUnits)));

        return res.status(200).json({
            period: { from: fromDate.toISOString(), to: toDate.toISOString(), tz },
            currency: workspace?.reportingCurrency || "USD",
            primaryRevenue: {
                totalRevenue: (Number(grossMinor) / 100).toFixed(2),
                totalRevenueFormatted: `$${(Number(grossMinor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                exclTax: (Number(exclTaxMinor) / 100).toFixed(2),
                tax: (Number(taxMinor) / 100).toFixed(2),
                invoicesCount,
                description: `Company-wide revenue, all locations combined, across ${invoicesCount} invoices.`,
            },
            kpis: {
                newCustomers: { value: newCustomers, label: "company-wide" },
                returningCustomers: { value: returningCustomers, label: "company-wide" },
                retention: {
                    percentage: retentionRate,
                    detail: `${retainedCustomersAllTime} of ${totalCustomersAllTime}, all-time`,
                },
                trackedVisits: { value: trackedVisits, label: "company-wide" },
            },
            revenueCards: {
                adAttributed: {
                    value: (Number(adAttributedMinor) / 100).toFixed(2),
                    formatted: `$${(Number(adAttributedMinor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    subtext: "Meta + Google + AWIN only",
                },
                directOrganic: {
                    value: (Number(directOrganicMinor) / 100).toFixed(2),
                    formatted: `$${(Number(directOrganicMinor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    subtext: "walk-ins & untracked",
                },
                unattributed: {
                    value: (Number(unattributedMinor) / 100).toFixed(2),
                    formatted: `$${(Number(unattributedMinor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    subtext: "no conversion at all",
                },
                refunded: {
                    value: (Number(refundMinor) / 100).toFixed(2),
                    formatted: `$-${(Number(refundMinor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    subtext: `${refunds.length} refunds · all locations`,
                },
                avgOrderValue: {
                    value: aov,
                    formatted: `$${Number(aov).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    changePercent: aovChangePercent,
                    trend: aovChangePercent >= 0 ? "up" : "down",
                    subtext: `${aovChangePercent >= 0 ? '▲' : '▼'} ${Math.abs(aovChangePercent)}% vs prior period`,
                },
            },
            revenueBySource,
            revenueByPlatform,
        });
    } catch (error) {
        if (error?.statusCode === 400) return res.status(400).json({ message: error.message });
        console.error("getDashboardOverview error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};
