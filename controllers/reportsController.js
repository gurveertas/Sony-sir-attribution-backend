/**
 * Reports — GET /v1/reports/* (secret key or dashboard session) and /api/workspace/reports/*.
 *
 * All reports accept: from, to (YYYY-MM-DD = whole company-local days, or ISO instants), tz, model,
 * locationId, channel, campaign, currency, includeTest, refundsBy=refund_date|order_date and
 * format=csv. Every number comes from services/metrics.js (section 6 definitions). Responses carry
 * `period`, `currency`, `model`, `lastUpdated` and, when relevant, `warnings`.
 *
 *   summary        overview KPIs + change vs the previous period
 *   channels       channel table (revenue, orders, new customers, spend, CAC, ROAS, AOV, days to convert);
 *                  compare=true adds the same channels under every model side by side
 *   campaigns      campaign table (filter channel=...)
 *   locations      location comparison and ranking (each location's own timezone)
 *   trend          daily trend with the previous period overlaid
 *   customers      new vs returning (with trend), cohorts by first-purchase month, LTV by acquisition channel
 *   cac            blended CAC, CAC per channel, ROAS, cost per booking, payback view
 *   spend          spend by platform / campaign with impressions + clicks, spend vs revenue, account warnings
 *   bookings       booking pipeline, status mix, cancellation / no-show / lead time by channel
 *   journeys       common paths, average touches + days to purchase, assisted conversions
 *   coverage       attribution coverage by match method and reason, by day
 *   data-quality   orders without token, duplicate customers, missing FX, suspicious amounts, out-of-order events
 *   alerts         connector failing, no events in 24h, coverage dropped
 *   dashboard      the Overview screen in one call
 */

import { db } from "../src/prisma/db.js";
import { tenantDb } from "../services/tenantDb.js";
import { resolveOpenRange, RangeInputError } from "../utils/timezone.js";
import {
    readParams,
    previousRange,
    loadFacts,
    summarize,
    channelRows,
    campaignRows,
    locationRows,
    trendRows,
    modelComparison,
    journeyStats,
    creditLines,
    shiftDay,
    pct,
    PAID_STATUSES,
} from "../services/metrics.js";
import { readRollups } from "../services/rollups.js";
import { loadSpend } from "../services/adSpend.js";
import { ATTRIBUTION_MODELS, UNATTRIBUTED_CHANNEL } from "../services/attributionEngine.js";
import { sendError, wantsCsv, sendCsv } from "../services/http.js";
import { formatMinor } from "../utils/money.js";
import { localDateString } from "../utils/timezone.js";

const DAY_MS = 86_400_000;
const PAID_CHANNELS = new Set(["google", "meta", "tiktok", "bing", "linkedin", "snapchat", "paid_other", "affiliate"]);
const CHANNEL_COLORS = {
    google: "#3b82f6", meta: "#a855f7", tiktok: "#111827", bing: "#0ea5e9", linkedin: "#0a66c2", snapchat: "#facc15",
    affiliate: "#71717a", email: "#f59e0b", sms: "#14b8a6", organic_search: "#22c55e", organic_social: "#ec4899",
    referral: "#84cc16", direct: "#10b981", direct_unknown: "#9ca3af", paid_other: "#6366f1",
};
const colorOf = (ch) => CHANNEL_COLORS[ch] ?? "#6366f1";
const CHANNEL_LABELS = {
    google: "Google", meta: "Meta", tiktok: "TikTok", bing: "Microsoft Ads", linkedin: "LinkedIn", snapchat: "Snapchat",
    affiliate: "Affiliate", email: "Email", sms: "SMS", organic_search: "Organic search", organic_social: "Organic social",
    referral: "Referral", direct: "Direct", direct_unknown: "Direct / unknown", paid_other: "Other paid",
};
export const channelLabel = (ch) => CHANNEL_LABELS[ch] ?? ch;

const workspaceIdOf = (req, WID) => (typeof WID === "string" ? WID : null) || req.workspaceId || req.user?.workspaceId || req.params?.workspaceId;

const periodOf = (p) => ({ from: p.range.fromDate.toISOString(), to: p.range.toDate.toISOString(), fromDay: p.range.fromDay, toDay: p.range.toDay, tz: p.tz });
const meta = (p, extra = {}) => ({ period: periodOf(p), tz: p.tz, currency: p.currency, model: p.model, lastUpdated: new Date().toISOString(), ...extra });
/** Warnings are always a list of plain sentences. */
const warningList = (factsWarnings, extra = []) => [
    ...(factsWarnings?.missingFxOrders
        ? [`${factsWarnings.missingFxOrders} order(s) in ${factsWarnings.missingFxCurrencies.join(", ")} have no exchange rate and are left out of money totals. Upload FX rates to include them.`]
        : []),
    ...extra,
];
const change = (cur, prev) => {
    const a = Number(cur);
    const b = Number(prev);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
    return Math.round(((a - b) / Math.abs(b)) * 1000) / 10;
};

/** Back-compat helper used by older code and tests. */
export async function parseReportParams(req, workspaceId) {
    const p = await readParams(req, workspaceId);
    return { fromDate: p.range.fromDate, toDate: p.range.toDate, model: p.model, locationId: p.locationId, tz: p.tz };
}

/**
 * Date window for LIST endpoints (orders, bookings), using the same local-day rule as the reports so a
 * drill-down list always adds up to the report total. Ends that were not supplied stay open.
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

/** Wraps a report: params -> handler -> JSON or CSV, with 400 for bad input. */
const report = (name, handler, csv) => async (req, res, WID) => {
    try {
        const workspaceId = workspaceIdOf(req, WID);
        if (!workspaceId) return res.status(400).json({ message: "Company context is required", code: "validation_error" });
        const params = await readParams(req, workspaceId);
        const body = await handler(req, params, workspaceId);
        if (csv && wantsCsv(req)) {
            const { rows, columns } = csv(body, params);
            return sendCsv(res, `${name}-${params.range.fromDay}-${params.range.toDay}.csv`, rows, columns);
        }
        return res.status(200).json(body);
    } catch (error) {
        if (error instanceof RangeInputError || error?.statusCode === 400) return res.status(400).json({ message: error.message, code: "validation_error" });
        return sendError(res, error, `report ${name}`);
    }
};

const applyChannelFilter = (facts, params) => {
    if (!params.channel && !params.campaign) return facts;
    // keep orders that credit the requested channel/campaign under the selected model
    const keep = new Set();
    for (const [orderId, credits] of facts.creditsByOrder) {
        if (credits.some((c) => c.model === params.model && (!params.channel || (c.channel ?? UNATTRIBUTED_CHANNEL) === params.channel) && (!params.campaign || (c.campaign ?? "(none)") === params.campaign))) keep.add(orderId);
    }
    return { ...facts, orders: facts.orders.filter((o) => keep.has(o.id)), refunds: facts.refunds.filter((r) => keep.has(r.orderId)) };
};

// ── summary ─────────────────────────────────────────────────────────────────

async function buildSummary(params, workspaceId) {
    const facts = applyChannelFilter(await loadFacts(workspaceId, params), params);
    const current = summarize(facts, params);
    const prevParams = { ...params, range: previousRange(params.range, params.tz) };
    const prevFacts = applyChannelFilter(await loadFacts(workspaceId, prevParams, { withBookings: true }), prevParams);
    const previous = summarize(prevFacts, prevParams);
    const changes = {
        netRevenue: change(current.revenue.netMinorUnits, previous.revenue.netMinorUnits),
        grossRevenue: change(current.revenue.grossMinorUnits, previous.revenue.grossMinorUnits),
        orders: change(current.orders.total, previous.orders.total),
        averageOrderValue: change(current.revenue.averageOrderValueMinorUnits, previous.revenue.averageOrderValueMinorUnits),
        newCustomers: change(current.orders.newCustomers, previous.orders.newCustomers),
        returningCustomers: change(current.orders.returningCustomers, previous.orders.returningCustomers),
        repeatRate: change(current.orders.repeatRate, previous.orders.repeatRate),
        coverage: change(current.attribution.coverageRate, previous.attribution.coverageRate),
    };
    return { facts, current, previous, changes, prevParams };
}

export const getSummaryReport = report(
    "summary",
    async (req, params, workspaceId) => {
        const { current, previous, changes, prevParams, facts } = await buildSummary(params, workspaceId);
        return { ...meta(params), ...current, previous: { period: periodOf(prevParams), ...previous }, changes, warnings: warningList(facts.warnings) };
    },
    (b) => ({
        rows: [
            ["Gross revenue", b.revenue.grossMinorUnits, b.previous.revenue.grossMinorUnits],
            ["Discounts", b.revenue.discountsMinorUnits, b.previous.revenue.discountsMinorUnits],
            ["Refunds", b.revenue.refundsMinorUnits, b.previous.revenue.refundsMinorUnits],
            ["Net revenue", b.revenue.netMinorUnits, b.previous.revenue.netMinorUnits],
            ["Orders", b.orders.total, b.previous.orders.total],
            ["Average order value", b.revenue.averageOrderValueMinorUnits, b.previous.revenue.averageOrderValueMinorUnits],
            ["New customers", b.orders.newCustomers, b.previous.orders.newCustomers],
            ["Returning customers", b.orders.returningCustomers, b.previous.orders.returningCustomers],
            ["Repeat rate %", b.orders.repeatRate, b.previous.orders.repeatRate],
            ["Attribution coverage %", b.attribution.coverageRate, b.previous.attribution.coverageRate],
        ].map(([metric, current, previous]) => ({ metric, current, previous })),
        columns: ["metric", "current", "previous"],
    }),
);

// ── channels / campaigns ────────────────────────────────────────────────────

async function rollupOrLiveChannels(params, workspaceId, spend) {
    const roll = !params.channel && !params.campaign ? await readRollups(params, { locationId: params.locationId }) : null;
    if (roll) {
        const by = new Map();
        for (const r of roll.attribution) {
            const e = by.get(r.channel) ?? { channel: r.channel, revenue: 0n, refunds: 0n, orders: 0, newC: 0 };
            e.revenue += BigInt(r.attributedMinorUnits ?? 0);
            e.refunds += BigInt(r.refundMinorUnits ?? 0);
            e.orders += Number(r.creditedOrders ?? 0);
            if (r.isNewCustomer) e.newC += Number(r.creditedOrders ?? 0);
            by.set(r.channel, e);
        }
        const rows = [...by.values()].map((e) => {
            const sp = spend.byChannel.get(e.channel) ?? null;
            const orders = Math.round(e.orders * 100) / 100;
            return {
                channel: e.channel,
                orders,
                netMinorUnits: e.revenue.toString(),
                refundsMinorUnits: e.refunds.toString(),
                newCustomers: Math.round(e.newC * 100) / 100,
                returningCustomers: Math.round((e.orders - e.newC) * 100) / 100,
                averageOrderValueMinorUnits: orders > 0 ? String(Math.round(Number(e.revenue) / orders)) : "0",
                spendMinorUnits: sp === null ? null : sp.toString(),
                cacMinorUnits: sp !== null && e.newC > 0 ? String(Math.round(Number(sp) / e.newC)) : null,
                roas: sp !== null && Number(sp) > 0 ? Math.round((Number(e.revenue) / Number(sp)) * 100) / 100 : null,
                averageDaysToConvert: null,
            };
        });
        for (const [channel, sp] of spend.byChannel) if (!by.has(channel)) rows.push({ channel, orders: 0, netMinorUnits: "0", refundsMinorUnits: "0", newCustomers: 0, returningCustomers: 0, averageOrderValueMinorUnits: "0", spendMinorUnits: sp.toString(), cacMinorUnits: null, roas: 0, averageDaysToConvert: null });
        return { rows: rows.sort((a, b) => Number(BigInt(b.netMinorUnits) - BigInt(a.netMinorUnits))), source: "rollups", builtAt: roll.builtAt };
    }
    const facts = applyChannelFilter(await loadFacts(workspaceId, params, { withTouches: true }), params);
    return { rows: channelRows(facts, params, spend.byChannel), source: "live", facts };
}

export const getChannelsReport = report(
    "channels",
    async (req, params, workspaceId) => {
        const spend = await loadSpend(workspaceId, { fromDay: params.range.fromDay, toDay: params.range.toDay, currency: params.currency, tz: params.tz, locationId: params.locationId });
        const { rows, source, facts } = await rollupOrLiveChannels(params, workspaceId, spend);
        const body = { ...meta(params), source, data: rows.map((r) => ({ ...r, label: channelLabel(r.channel), color: colorOf(r.channel) })), warnings: warningList(facts?.warnings, spend.warnings) };
        if (req.query.compare === "true") {
            const all = await loadFacts(workspaceId, params, { models: ATTRIBUTION_MODELS, withBookings: false });
            body.comparison = { models: ATTRIBUTION_MODELS, data: modelComparison(applyChannelFilter(all, { ...params, channel: null, campaign: null })) };
        }
        return body;
    },
    (b) => ({ rows: b.data, columns: ["channel", "label", "orders", "netMinorUnits", "refundsMinorUnits", "newCustomers", "returningCustomers", "averageOrderValueMinorUnits", "spendMinorUnits", "cacMinorUnits", "roas", "averageDaysToConvert"] }),
);

export const getCampaignsReport = report(
    "campaigns",
    async (req, params, workspaceId) => {
        const spend = await loadSpend(workspaceId, { fromDay: params.range.fromDay, toDay: params.range.toDay, currency: params.currency, tz: params.tz, locationId: params.locationId });
        const facts = applyChannelFilter(await loadFacts(workspaceId, params), params);
        let rows = campaignRows(facts, params, spend.byCampaign);
        if (params.channel) rows = rows.filter((r) => r.channel === params.channel);
        return { ...meta(params), data: rows.map((r) => ({ ...r, label: channelLabel(r.channel) })), warnings: warningList(facts.warnings, spend.warnings) };
    },
    (b) => ({ rows: b.data, columns: ["channel", "campaign", "orders", "netMinorUnits", "newCustomers", "spendMinorUnits", "cacMinorUnits", "roas"] }),
);

// ── locations / trend ───────────────────────────────────────────────────────

export const getLocationsReport = report(
    "locations",
    async (req, params, workspaceId) => {
        const spend = await loadSpend(workspaceId, { fromDay: params.range.fromDay, toDay: params.range.toDay, currency: params.currency, tz: params.tz });
        const facts = applyChannelFilter(await loadFacts(workspaceId, { ...params, locationId: null, locationIds: params.locationIds && params.locationIds.length > 1 ? params.locationIds : null }), params);
        return { ...meta(params), data: locationRows(facts, params, spend.byLocation), warnings: warningList(facts.warnings) };
    },
    (b) => ({ rows: b.data, columns: ["rank", "locationName", "timezone", "orders", "netMinorUnits", "newCustomers", "returningCustomers", "bookings", "bookedValueMinorUnits", "spendMinorUnits", "cacMinorUnits", { key: "topSources", label: "topSources", value: (r) => r.topSources.map((t) => t.channel).join("; ") }] }),
);

export const getTrendReport = report(
    "trend",
    async (req, params, workspaceId) => {
        const facts = applyChannelFilter(await loadFacts(workspaceId, params, { withCredits: Boolean(params.channel || params.campaign) }), params);
        const data = trendRows(facts, params);
        const prevParams = { ...params, range: previousRange(params.range, params.tz) };
        const prevFacts = applyChannelFilter(await loadFacts(workspaceId, prevParams, { withCredits: Boolean(params.channel || params.campaign) }), prevParams);
        const prev = trendRows(prevFacts, prevParams);
        // align the previous period day-by-day for the overlay
        const previous = data.map((d, i) => ({ date: d.date, previousDate: prev[i]?.date ?? null, netMinorUnits: prev[i]?.netMinorUnits ?? "0", orders: prev[i]?.orders ?? 0 }));
        return { ...meta(params), data, previous, warnings: warningList(facts.warnings) };
    },
    (b) => ({ rows: b.data, columns: ["date", "orders", "grossMinorUnits", "refundsMinorUnits", "netMinorUnits", "newCustomers", "bookings"] }),
);

// ── customers: new vs returning, cohorts, LTV ───────────────────────────────

export const getCustomersReport = report(
    "customers",
    async (req, params, workspaceId) => {
        const t = tenantDb(db, workspaceId);
        const facts = applyChannelFilter(await loadFacts(workspaceId, params, { withBookings: false }), params);
        const s = summarize({ ...facts, bookings: [] }, params);

        // new vs returning split by day
        const split = new Map();
        for (const o of facts.orders) {
            if (!o.customerId) continue;
            const e = split.get(o.day) ?? { date: o.day, newCustomers: new Set(), returningCustomers: new Set() };
            (o.isNew ? e.newCustomers : e.returningCustomers).add(o.customerId);
            split.set(o.day, e);
        }
        const trend = [...split.values()].sort((a, b) => a.date.localeCompare(b.date)).map((e) => ({ date: e.date, newCustomers: e.newCustomers.size, returningCustomers: e.returningCustomers.size }));

        // cohorts by first-purchase month (company local month), repeat purchase rate in later months
        const allOrders = (await t.Order.all()).filter((o) => PAID_STATUSES.includes(o.status) && !o.isTest && o.customerId);
        const byCustomer = new Map();
        for (const o of allOrders) {
            const list = byCustomer.get(o.customerId) ?? [];
            list.push(o);
            byCustomer.set(o.customerId, list);
        }
        const monthOf = (iso) => localDateString(new Date(iso), params.tz).slice(0, 7);
        const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
        const cohorts = new Map();
        const fromMonth = params.range.fromDay.slice(0, 7);
        const toMonth = params.range.toDay.slice(0, 7);
        for (const list of byCustomer.values()) {
            list.sort((a, b) => new Date(a.orderedAt) - new Date(b.orderedAt));
            const first = monthOf(list[0].orderedAt);
            if (first < fromMonth || first > toMonth) continue;
            const c = cohorts.get(first) ?? { cohort: first, customers: 0, returnedByMonth: new Map(), revenueMinorUnits: 0n };
            c.customers++;
            const months = new Set(list.slice(1).map((o) => monthIndex(monthOf(o.orderedAt)) - monthIndex(first)).filter((m) => m >= 1 && m <= 12));
            for (const m of months) c.returnedByMonth.set(m, (c.returnedByMonth.get(m) ?? 0) + 1);
            c.revenueMinorUnits += list.reduce((sum, o) => sum + BigInt(o.netMinorUnits ?? 0) - BigInt(o.refundedMinorUnits ?? 0), 0n);
            cohorts.set(first, c);
        }
        const cohortRows = [...cohorts.values()]
            .sort((a, b) => a.cohort.localeCompare(b.cohort))
            .map((c) => ({
                cohort: c.cohort,
                customers: c.customers,
                revenueMinorUnits: c.revenueMinorUnits.toString(),
                repeatRateByMonth: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, rate: pct(c.returnedByMonth.get(i + 1) ?? 0, c.customers) })),
            }));

        // lifetime value by acquisition channel (channel credited on the customer's first paid order)
        const credits = await t.AttributionCredit.where({ model: params.model }).all();
        const creditsByOrder = new Map();
        for (const c of credits) if (c.orderId) (creditsByOrder.get(c.orderId) ?? creditsByOrder.set(c.orderId, []).get(c.orderId)).push(c);
        const ltv = new Map();
        for (const list of byCustomer.values()) {
            const first = list[0];
            const firstDay = localDateString(new Date(first.orderedAt), params.tz);
            if (firstDay < params.range.fromDay || firstDay > params.range.toDay) continue;
            const best = [...(creditsByOrder.get(first.id) ?? [])].sort((a, b) => Number(BigInt(b.amountMinorUnits ?? 0) - BigInt(a.amountMinorUnits ?? 0)))[0];
            const ch = best?.channel ?? UNATTRIBUTED_CHANNEL;
            const value = list.reduce((sum, o) => sum + BigInt(o.netMinorUnits ?? 0) - BigInt(o.refundedMinorUnits ?? 0), 0n);
            const e = ltv.get(ch) ?? { channel: ch, customers: 0, revenue: 0n, orders: 0 };
            e.customers++;
            e.revenue += value;
            e.orders += list.length;
            ltv.set(ch, e);
        }
        const ltvRows = [...ltv.values()]
            .map((e) => ({ channel: e.channel, label: channelLabel(e.channel), customers: e.customers, lifetimeRevenueMinorUnits: e.revenue.toString(), averageLtvMinorUnits: (e.revenue / BigInt(e.customers)).toString(), averageOrders: Math.round((e.orders / e.customers) * 100) / 100 }))
            .sort((a, b) => b.customers - a.customers);

        const totalCustomers = (await t.Customer.where((c) => c.mergedIntoId.isNull()).all()).filter((c) => !c.erasedAt).length;
        return {
            ...meta(params),
            newCustomers: s.orders.newCustomers,
            returningCustomers: s.orders.returningCustomers,
            totalCustomers,
            repeatRate: s.orders.repeatRate,
            newCustomerRevenueMinorUnits: s.revenue.newCustomerRevenueMinorUnits,
            trend,
            cohorts: cohortRows,
            ltvByChannel: ltvRows,
            note: "Cohort and LTV values use each order's own currency amounts; multi-currency companies should read them per currency.",
        };
    },
    (b) => ({ rows: b.ltvByChannel, columns: ["channel", "label", "customers", "lifetimeRevenueMinorUnits", "averageLtvMinorUnits", "averageOrders"] }),
);

// ── CAC / spend ─────────────────────────────────────────────────────────────

export const getCacReport = report(
    "cac",
    async (req, params, workspaceId) => {
        const spend = await loadSpend(workspaceId, { fromDay: params.range.fromDay, toDay: params.range.toDay, currency: params.currency, tz: params.tz, locationId: params.locationId });
        const facts = await loadFacts(workspaceId, params, { withTouches: false });
        const s = summarize(facts, params);
        const channels = channelRows(facts, params, spend.byChannel);
        const attributed = channels.filter((c) => c.channel !== UNATTRIBUTED_CHANNEL).reduce((a, c) => a + BigInt(c.netMinorUnits), 0n);
        const bookingsCreated = facts.bookings.filter((b) => b.inPeriod).length;
        const total = spend.total;

        // payback: cumulative net revenue per new customer, by months since acquisition, vs blended CAC
        const t = tenantDb(db, workspaceId);
        const newCustomers = new Map(facts.orders.filter((o) => o.isNew).map((o) => [o.customerId, o.orderedAt]));
        const monthly = Array(13).fill(0n);
        for (const [customerId, firstAt] of newCustomers) {
            for (const o of await t.Order.where({ customerId }).all()) {
                if (!PAID_STATUSES.includes(o.status)) continue;
                const months = Math.floor((new Date(o.orderedAt) - new Date(firstAt)) / (30.44 * DAY_MS));
                if (months >= 0 && months <= 12) monthly[months] += BigInt(o.netMinorUnits ?? 0) - BigInt(o.refundedMinorUnits ?? 0);
            }
        }
        const blendedCac = s.orders.newCustomers > 0 ? total / BigInt(s.orders.newCustomers) : null;
        let running = 0n;
        let paybackMonth = null;
        const payback = monthly.map((v, m) => {
            running += v;
            const perCustomer = newCustomers.size ? running / BigInt(newCustomers.size) : 0n;
            if (paybackMonth === null && blendedCac !== null && perCustomer >= blendedCac) paybackMonth = m;
            return { monthsSinceAcquisition: m, cumulativeRevenuePerCustomerMinorUnits: perCustomer.toString() };
        });

        return {
            ...meta(params),
            spendAvailable: spend.available,
            spendMinorUnits: total.toString(),
            newCustomers: s.orders.newCustomers,
            blendedCacMinorUnits: blendedCac === null ? null : blendedCac.toString(),
            attributedRevenueMinorUnits: attributed.toString(),
            roas: Number(total) > 0 ? Math.round((Number(attributed) / Number(total)) * 100) / 100 : null,
            bookingsCreated,
            costPerBookingMinorUnits: bookingsCreated > 0 ? (total / BigInt(bookingsCreated)).toString() : null,
            byChannel: channels.filter((c) => c.spendMinorUnits !== null).map((c) => ({ channel: c.channel, label: channelLabel(c.channel), spendMinorUnits: c.spendMinorUnits, newCustomers: c.newCustomers, cacMinorUnits: c.cacMinorUnits, netMinorUnits: c.netMinorUnits, roas: c.roas })),
            payback,
            paybackMonths: paybackMonth,
            definition: "Channel CAC = channel spend ÷ new customers credited to the channel under the selected model (fractional for multi-touch models). Blended CAC = all spend ÷ all new customers.",
            warnings: spend.warnings,
        };
    },
    (b) => ({ rows: b.byChannel, columns: ["channel", "label", "spendMinorUnits", "newCustomers", "cacMinorUnits", "netMinorUnits", "roas"] }),
);

export const getSpendReport = report(
    "spend",
    async (req, params, workspaceId) => {
        const spend = await loadSpend(workspaceId, { fromDay: params.range.fromDay, toDay: params.range.toDay, currency: params.currency, tz: params.tz, locationId: params.locationId });
        const facts = await loadFacts(workspaceId, params, { withBookings: false, withCredits: false });
        const revenueByDay = new Map(trendRows(facts, params).map((d) => [d.date, d.netMinorUnits]));
        const campaigns = new Map();
        for (const r of spend.rows) {
            const key = `${r.platform}::${r.campaignName}`;
            const e = campaigns.get(key) ?? { platform: r.platform, channel: r.channel, campaign: r.campaignName, spendMinorUnits: 0n, impressions: 0, clicks: 0 };
            e.spendMinorUnits += r.convertedMinorUnits;
            e.impressions += r.impressions ?? 0;
            e.clicks += r.clicks ?? 0;
            campaigns.set(key, e);
        }
        const days = [];
        for (let d = params.range.fromDay; d <= params.range.toDay; d = shiftDay(d, 1)) days.push({ date: d, spendMinorUnits: (spend.byDay.get(d) ?? 0n).toString(), netMinorUnits: revenueByDay.get(d) ?? "0" });
        return {
            ...meta(params),
            spendAvailable: spend.available,
            totalSpendMinorUnits: spend.total.toString(),
            impressions: spend.impressions,
            clicks: spend.clicks,
            byPlatform: [...spend.byPlatform.entries()].map(([platform, v]) => ({ platform, spendMinorUnits: v.toString() })),
            campaigns: [...campaigns.values()].sort((a, b) => Number(b.spendMinorUnits - a.spendMinorUnits)).map((c) => ({ ...c, spendMinorUnits: c.spendMinorUnits.toString(), ctr: c.impressions ? Math.round((c.clicks / c.impressions) * 10000) / 100 : null, cpcMinorUnits: c.clicks ? String(c.spendMinorUnits / BigInt(c.clicks)) : null })),
            trend: days,
            warnings: spend.warnings,
        };
    },
    (b) => ({ rows: b.campaigns, columns: ["platform", "channel", "campaign", "spendMinorUnits", "impressions", "clicks", "ctr", "cpcMinorUnits"] }),
);

// ── bookings ────────────────────────────────────────────────────────────────

export const getBookingsReport = report(
    "bookings",
    async (req, params, workspaceId) => {
        const t = tenantDb(db, workspaceId);
        const facts = await loadFacts(workspaceId, params, { withCredits: true });
        const created = facts.bookings.filter((b) => b.inPeriod);
        const s = summarize(facts, params).bookings;
        const statusMix = {};
        for (const b of created) statusMix[b.raw.status] = (statusMix[b.raw.status] ?? 0) + 1;

        // pipeline: created in period -> completed -> paid (an order linked to the booking)
        const paidOrders = (await t.Order.all()).filter((o) => o.bookingId && PAID_STATUSES.includes(o.status));
        const paidByBooking = new Map();
        for (const o of paidOrders) paidByBooking.set(o.bookingId, (paidByBooking.get(o.bookingId) ?? 0n) + BigInt(o.netMinorUnits ?? 0) - BigInt(o.refundedMinorUnits ?? 0));
        const completed = created.filter((b) => b.raw.status === "completed");
        const paid = created.filter((b) => paidByBooking.has(b.id));

        // by channel under the selected model (primary credited channel of each booking)
        const now = new Date();
        const byChannel = new Map();
        for (const b of created) {
            const credits = (facts.creditsByBooking.get(b.id) ?? []).filter((c) => c.model === params.model);
            const best = credits.sort((x, y) => Number(y.share) - Number(x.share))[0];
            const ch = best?.channel ?? UNATTRIBUTED_CHANNEL;
            const e = byChannel.get(ch) ?? { channel: ch, created: 0, cancelled: 0, pastScheduled: 0, noShow: 0, leadHours: [], bookedValue: 0n, paid: 0 };
            e.created++;
            if (b.raw.status === "cancelled") e.cancelled++;
            if (new Date(b.raw.appointmentStartAt) < now && b.raw.status !== "cancelled") {
                e.pastScheduled++;
                if (b.raw.status === "no_show") e.noShow++;
            }
            const lead = (new Date(b.raw.appointmentStartAt) - new Date(b.bookedAt)) / 3600_000;
            if (Number.isFinite(lead) && lead >= 0) e.leadHours.push(lead);
            if (["scheduled", "confirmed", "rescheduled"].includes(b.raw.status)) e.bookedValue += b.value;
            if (paidByBooking.has(b.id)) e.paid++;
            byChannel.set(ch, e);
        }
        const channels = [...byChannel.values()].map((e) => ({
            channel: e.channel,
            label: channelLabel(e.channel),
            created: e.created,
            bookedValueMinorUnits: e.bookedValue.toString(),
            cancellationRate: pct(e.cancelled, e.created),
            noShowRate: pct(e.noShow, e.pastScheduled),
            averageLeadTimeHours: e.leadHours.length ? Math.round((e.leadHours.reduce((a, c) => a + c, 0) / e.leadHours.length) * 10) / 10 : null,
            paid: e.paid,
        }));

        return {
            ...meta(params),
            ...s,
            statusMix,
            pipeline: {
                created: created.length,
                completed: completed.length,
                paid: paid.length,
                bookedValueMinorUnits: created.reduce((a, b) => a + b.value, 0n).toString(),
                realizedRevenueMinorUnits: paid.reduce((a, b) => a + (paidByBooking.get(b.id) ?? 0n), 0n).toString(),
                completionRate: pct(completed.length, created.length),
                paidRate: pct(paid.length, created.length),
            },
            byChannel: channels.sort((a, b) => b.created - a.created),
        };
    },
    (b) => ({ rows: b.byChannel, columns: ["channel", "label", "created", "bookedValueMinorUnits", "cancellationRate", "noShowRate", "averageLeadTimeHours", "paid"] }),
);

// ── journeys / coverage ─────────────────────────────────────────────────────

export const getJourneysReport = report(
    "journeys",
    async (req, params, workspaceId) => {
        const facts = applyChannelFilter(await loadFacts(workspaceId, params, { models: [params.model, "linear"], withTouches: true, withBookings: false }), params);
        // journeyStats reads the linear credits (every touch of the journey) — touches must be loaded for them
        const t = tenantDb(db, workspaceId);
        for (const list of facts.creditsByOrder.values()) for (const c of list) if (c.touchId && !facts.touchesById.has(c.touchId)) {
            const touch = await t.Touch.where({ id: c.touchId }).first();
            if (touch) facts.touchesById.set(c.touchId, touch);
        }
        return { ...meta(params), ...journeyStats(facts, { limit: Math.min(100, parseInt(req.query.limit, 10) || 20) }) };
    },
    (b) => ({ rows: b.paths, columns: ["path", "orders", "revenueMinorUnits"] }),
);

export const getCoverageReport = report(
    "coverage",
    async (req, params, workspaceId) => {
        const facts = await loadFacts(workspaceId, params, { withBookings: false, withCredits: false });
        const s = summarize({ ...facts, bookings: [] }, params);
        const reasons = new Map();
        for (const o of facts.orders) {
            if (o.matchMethod !== "none") continue;
            const r = o.raw.attributionReason || "no_source_found";
            const e = reasons.get(r) ?? { reason: r, orders: 0, revenueMinorUnits: 0n };
            e.orders++;
            e.revenueMinorUnits += o.net;
            reasons.set(r, e);
        }
        const byDay = new Map();
        for (const o of facts.orders) {
            const e = byDay.get(o.day) ?? { date: o.day, total: 0n, matched: 0n };
            e.total += o.net;
            if (o.matchMethod !== "none") e.matched += o.net;
            byDay.set(o.day, e);
        }
        return {
            ...meta(params),
            coverageRate: s.attribution.coverageRate,
            matchedRevenueMinorUnits: s.attribution.matchedRevenueMinorUnits,
            byMatchMethod: s.attribution.byMatchMethod,
            unattributedReasons: [...reasons.values()].map((r) => ({ ...r, revenueMinorUnits: r.revenueMinorUnits.toString() })).sort((a, b) => b.orders - a.orders),
            trend: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ date: d.date, coverageRate: pct(d.matched, d.total) })),
        };
    },
    (b) => ({ rows: b.byMatchMethod, columns: ["matchMethod", "orders", "revenueMinorUnits", "share"] }),
);

// ── data quality / alerts ───────────────────────────────────────────────────

export const getDataQualityReport = report(
    "data-quality",
    async (req, params, workspaceId) => {
        const t = tenantDb(db, workspaceId);
        const facts = await loadFacts(workspaceId, params, { withBookings: false, withCredits: false });
        const orders = facts.orders;
        const noToken = orders.filter((o) => o.matchMethod !== "token");

        const customers = (await t.Customer.where((c) => c.mergedIntoId.isNull()).all()).filter((c) => !c.erasedAt);
        const groups = new Map();
        for (const c of customers) {
            for (const [field, h] of [["email", c.emailHash], ["phone", c.phoneHash]]) {
                if (!h) continue;
                const k = `${field}:${h}`;
                (groups.get(k) ?? groups.set(k, []).get(k)).push(c.id);
            }
        }
        const duplicates = [...groups.entries()].filter(([, ids]) => ids.length > 1).map(([k, ids]) => ({ matchedOn: k.split(":")[0], customerIds: ids }));

        const nets = orders.map((o) => Number(o.net)).filter((n) => n > 0).sort((a, b) => a - b);
        const median = nets.length ? nets[Math.floor(nets.length / 2)] : 0;
        const suspicious = orders
            .filter((o) => o.net <= 0n || (median > 0 && Number(o.net) > median * 50))
            .map((o) => ({ orderId: o.id, externalId: o.raw.externalId, netMinorUnits: o.net.toString(), reason: o.net <= 0n ? "zero_or_negative" : "far_above_typical" }));

        const raw = await t.RawEvent.where((e) => e.receivedAt.gte(params.range.fromDate.toISOString())).all();
        const outOfOrder = raw.filter((e) => /not found/i.test(String(e.error ?? "")) && ["failed", "dead"].includes(e.status));
        const future = orders.filter((o) => new Date(o.orderedAt) > new Date(Date.now() + 10 * 60_000));

        const sample = (list, n = 20) => list.slice(0, n);
        return {
            ...meta(params),
            checks: [
                { key: "orders_without_token", label: "Orders with no checkout token", count: noToken.length, share: pct(noToken.length, orders.length), sample: sample(noToken.map((o) => ({ orderId: o.id, externalId: o.raw.externalId, matchMethod: o.matchMethod }))) },
                { key: "duplicate_customers", label: "Possible duplicate customers", count: duplicates.length, sample: sample(duplicates) },
                { key: "missing_currency_rate", label: "Orders without an exchange rate", count: facts.warnings.missingFxOrders, sample: facts.warnings.missingFxCurrencies.map((c) => ({ currency: c })) },
                { key: "suspicious_amounts", label: "Amounts that look wrong", count: suspicious.length, sample: sample(suspicious) },
                { key: "out_of_order_events", label: "Events that arrived before what they refer to", count: outOfOrder.length, sample: sample(outOfOrder.map((e) => ({ eventId: e.id, eventType: e.eventType, status: e.status, error: e.error }))) },
                { key: "future_dated_orders", label: "Orders dated in the future", count: future.length, sample: sample(future.map((o) => ({ orderId: o.id, orderedAt: o.orderedAt }))) },
                { key: "dead_events", label: "Events that failed permanently", count: raw.filter((e) => e.status === "dead").length },
            ],
        };
    },
    (b) => ({ rows: b.checks, columns: ["key", "label", "count", "share"] }),
);

export async function computeAlerts(workspaceId) {
    const t = tenantDb(db, workspaceId);
    const alerts = [];
    const connectors = await t.Connector.all();
    for (const c of connectors.filter((x) => x.status === "failing")) {
        alerts.push({ type: "connector_failing", severity: "high", message: `${c.name} (${c.type}) is failing: ${c.lastError ?? "see the event log"}`, connectorId: c.id, since: c.lastErrorAt ?? null });
    }
    const active = connectors.filter((c) => c.status !== "disabled");
    const lastEvent = active.map((c) => c.lastEventAt).filter(Boolean).sort().at(-1);
    const latestTouch = (await t.Touch.where({ workspaceId }).orderBy((x) => x.touchedAt.desc()).limit(1).all())[0];
    const last = [lastEvent, latestTouch?.touchedAt].filter(Boolean).sort().at(-1);
    const hasIntegrations = active.length > 0 || Boolean(latestTouch);
    if (hasIntegrations && (!last || Date.now() - new Date(last).getTime() > DAY_MS)) {
        alerts.push({ type: "no_events_24h", severity: "medium", message: "No events received in the last 24 hours", lastEventAt: last ?? null });
    }
    // coverage dropped: last 7 days vs the 7 before, by more than 10 points
    const orders = (await t.Order.where((o) => o.orderedAt.gte(new Date(Date.now() - 14 * DAY_MS).toISOString())).all()).filter((o) => PAID_STATUSES.includes(o.status) && !o.isTest);
    const cut = Date.now() - 7 * DAY_MS;
    const cov = (list) => {
        const total = list.reduce((a, o) => a + Number(o.netMinorUnits ?? 0), 0);
        const matched = list.filter((o) => o.matchMethod !== "none").reduce((a, o) => a + Number(o.netMinorUnits ?? 0), 0);
        return total > 0 ? (matched / total) * 100 : null;
    };
    const recent = cov(orders.filter((o) => new Date(o.orderedAt).getTime() >= cut));
    const before = cov(orders.filter((o) => new Date(o.orderedAt).getTime() < cut));
    if (recent !== null && before !== null && before - recent > 10) {
        alerts.push({ type: "coverage_dropped", severity: "medium", message: `Attribution coverage fell from ${before.toFixed(1)}% to ${recent.toFixed(1)}% over the last 7 days`, previous: Math.round(before * 10) / 10, current: Math.round(recent * 10) / 10 });
    }
    return alerts;
}

export const getAlerts = async (req, res, WID) => {
    try {
        const workspaceId = workspaceIdOf(req, WID);
        return res.status(200).json({ data: await computeAlerts(workspaceId), lastUpdated: new Date().toISOString() });
    } catch (error) {
        return sendError(res, error, "alerts");
    }
};

// ── overview (dashboard) ────────────────────────────────────────────────────

function money(minor, currency) {
    const major = Number(formatMinor(minor, currency));
    try {
        return new Intl.NumberFormat("en", { style: "currency", currency }).format(major);
    } catch {
        return `${currency} ${major.toFixed(2)}`;
    }
}

/**
 * GET /api/workspace/dashboard | /v1/reports/dashboard — the Overview screen (5.1) in one call:
 * KPIs with change vs previous period, revenue by channel (ledger bar), trend with previous period,
 * top campaigns, top locations, attribution coverage by match method, alerts.
 */
export const getDashboardOverview = report("dashboard", async (req, params, workspaceId) => {
    const { facts, current, previous, changes } = await buildSummary(params, workspaceId);
    const cur = params.currency;
    const lines = creditLines(facts, params.model);

    const byChannel = new Map();
    for (const l of lines) {
        const e = byChannel.get(l.channel) ?? { channel: l.channel, revenue: 0n, conversions: 0 };
        e.revenue += l.amount;
        if (l.kind === "sale") e.conversions += l.share;
        byChannel.set(l.channel, e);
    }
    const totalAttributedBase = [...byChannel.values()].reduce((a, e) => a + (e.revenue > 0n ? e.revenue : 0n), 0n);
    const sorted = [...byChannel.values()].sort((a, b) => Number(b.revenue - a.revenue));
    const ad = sorted.filter((e) => PAID_CHANNELS.has(e.channel)).reduce((a, e) => a + e.revenue, 0n);
    const unattributed = byChannel.get(UNATTRIBUTED_CHANNEL)?.revenue ?? 0n;
    const directOrganic = sorted.filter((e) => !PAID_CHANNELS.has(e.channel) && e.channel !== UNATTRIBUTED_CHANNEL).reduce((a, e) => a + e.revenue, 0n);

    const t = tenantDb(db, workspaceId);
    const visits = (await t.Touch.where((x) => x.touchedAt.gte(params.range.fromDate.toISOString())).where((x) => x.touchedAt.lte(params.range.toDate.toISOString())).all()).filter((x) => params.includeTest || !x.isTest).length;
    const allCustomers = (await t.Customer.where((c) => c.mergedIntoId.isNull()).all()).filter((c) => c.firstPurchaseAt);
    const retained = allCustomers.filter((c) => c.lastPurchaseAt && c.lastPurchaseAt !== c.firstPurchaseAt).length;

    const campaigns = campaignRows(facts, params).slice(0, 5);
    const locations = locationRows(facts, params).slice(0, 5);
    const trend = trendRows(facts, params);
    const prevFacts = await loadFacts(workspaceId, { ...params, range: previousRange(params.range, params.tz) }, { withCredits: false, withBookings: false });
    const prevTrend = trendRows(prevFacts, { ...params, range: previousRange(params.range, params.tz) });
    const alerts = await computeAlerts(workspaceId);

    const net = BigInt(current.revenue.netMinorUnits);
    const gross = BigInt(current.revenue.grossMinorUnits);
    const tax = BigInt(current.revenue.taxMinorUnits);
    const refunds = BigInt(current.revenue.refundsMinorUnits);
    const aov = BigInt(current.revenue.averageOrderValueMinorUnits);
    const major = (v) => formatMinor(v, cur);

    return {
        ...meta(params),
        summary: current,
        previous,
        changes,
        primaryRevenue: {
            totalRevenue: major(net),
            totalRevenueFormatted: money(net, cur),
            grossRevenue: major(gross),
            exclTax: major(gross),
            tax: major(tax),
            invoicesCount: current.orders.total,
            changePercent: changes.netRevenue,
            description: `Net revenue (gross ${money(gross, cur)} − discounts − refunds, tax excluded) across ${current.orders.total} paid orders.`,
        },
        kpis: {
            newCustomers: { value: current.orders.newCustomers, changePercent: changes.newCustomers, label: "first paid order in the period" },
            returningCustomers: { value: current.orders.returningCustomers, changePercent: changes.returningCustomers, label: "had an earlier paid order" },
            repeatRate: { percentage: current.orders.repeatRate, changePercent: changes.repeatRate },
            retention: { percentage: pct(retained, allCustomers.length), detail: `${retained} of ${allCustomers.length} customers bought more than once, all-time` },
            trackedVisits: { value: visits, label: "touches recorded" },
            orders: { value: current.orders.total, changePercent: changes.orders },
        },
        revenueCards: {
            adAttributed: { value: major(ad), formatted: money(ad, cur), subtext: "paid channels under the selected model" },
            directOrganic: { value: major(directOrganic), formatted: money(directOrganic, cur), subtext: "direct, organic, email, referral" },
            unattributed: { value: major(unattributed), formatted: money(unattributed, cur), subtext: "Direct / unknown — no source found" },
            refunded: { value: major(refunds), formatted: money(-refunds, cur), subtext: `${current.orders.refundCount} refunds in the period` },
            avgOrderValue: {
                value: major(aov),
                formatted: money(aov, cur),
                changePercent: changes.averageOrderValue,
                trend: (changes.averageOrderValue ?? 0) >= 0 ? "up" : "down",
                subtext: changes.averageOrderValue === null ? "no previous period to compare" : `${changes.averageOrderValue >= 0 ? "▲" : "▼"} ${Math.abs(changes.averageOrderValue)}% vs previous period`,
            },
        },
        revenueBySource: sorted
            .filter((e) => e.revenue !== 0n)
            .map((e) => ({
                source: channelLabel(e.channel),
                channel: e.channel,
                percentage: totalAttributedBase > 0n && e.revenue > 0n ? Math.round((Number(e.revenue) / Number(totalAttributedBase)) * 1000) / 10 : 0,
                color: colorOf(e.channel),
                revenue: major(e.revenue),
                revenueMinorUnits: e.revenue.toString(),
                conversions: Math.round(e.conversions * 100) / 100,
            })),
        revenueByPlatform: sorted.map((e) => ({
            platform: channelLabel(e.channel),
            channel: e.channel,
            badge: channelLabel(e.channel),
            conversions: Math.round(e.conversions * 100) / 100,
            revenue: major(e.revenue),
            revenueMinorUnits: e.revenue.toString(),
            color: colorOf(e.channel),
        })),
        coverage: { rate: current.attribution.coverageRate, byMatchMethod: current.attribution.byMatchMethod, changePercent: changes.coverage },
        trend: trend.map((d, i) => ({ ...d, previousNetMinorUnits: prevTrend[i]?.netMinorUnits ?? "0", previousDate: prevTrend[i]?.date ?? null })),
        topCampaigns: campaigns,
        topLocations: locations,
        alerts,
        warnings: warningList(facts.warnings),
    };
});

export { channelRows, PAID_STATUSES, shiftDay as _shiftDay };
