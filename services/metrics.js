/**
 * Metrics engine (scope 4.7 + section 6). Every number on the dashboard, in the API and in CSV
 * exports is computed HERE, from one written definition each:
 *
 *   Gross revenue       Σ paid order totals before discounts and refunds, excluding tax (orders by order date)
 *   Discounts           Σ discounts on those orders
 *   Refunds             Σ refunds dated in the period (refundsBy=order_date shows them against the sale date)
 *   Net revenue         gross − discounts − refunds          (= realized revenue)
 *   Orders              count of paid orders (paid / partially refunded / refunded; pending + voided excluded)
 *   Average order value net revenue ÷ orders
 *   New customer        customer whose paid order is their first paid order (flag stored on the order)
 *   Returning customer  customer with at least one earlier paid order
 *   New customer revenue net revenue of orders by new customers
 *   Repeat rate         customers with ≥2 paid orders ÷ customers with ≥1, in the period
 *   Attributed revenue  net revenue × the credit share for the selected model (refunds reduce it with the
 *                       original order's shares, on the refund date)
 *   Attribution coverage revenue with a matched source ÷ total revenue (+ how it was matched)
 *   Booked value        Σ service prices of bookings with status scheduled / confirmed
 *   Cancellation rate   cancelled bookings ÷ bookings created in the period
 *   No-show rate        no-show bookings ÷ past bookings that were scheduled (not cancelled)
 *   Lead time           appointment start − booking created time
 *   Days to convert     first touch time → order time
 *   CAC                 ad spend ÷ new customers (blended; per channel the new customers credited to the
 *                       channel under the selected model, fractional for multi-touch models)
 *   ROAS                attributed revenue ÷ ad spend
 *   Cost per booking    ad spend ÷ bookings created
 *
 * A "day" is the company's local day; a location with its own timezone uses that timezone for its
 * own day boundaries. Money is converted to the reporting currency with the FX rate stored on each
 * order at ingestion; an order without a rate is left out of money totals and reported in `warnings`.
 * Test-mode (sandbox) data is excluded unless includeTest=true.
 */

import { db } from "../src/prisma/db.js";
import { tenantDb } from "./tenantDb.js";
import { ATTRIBUTION_MODELS, DEFAULT_MODEL, UNATTRIBUTED_CHANNEL } from "./attributionEngine.js";
import { allocateMinor, currencyExponent } from "../utils/money.js";
import { findRate } from "./fx.js";
import { localDateString, localMidnightUtc, parseDateOnly, isValidTimeZone, RangeInputError, addDays } from "../utils/timezone.js";

export const PAID_STATUSES = ["paid", "partially_refunded", "refunded"];
const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────
// Parameters
// ─────────────────────────────────────────────────────────────────────────────

const dayStr = ({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const parseDay = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return { y, m, d };
};
export const shiftDay = (s, n) => dayStr(addDays(parseDay(s), n));

/**
 * Report parameters (all reports): from, to (YYYY-MM-DD local days, or full ISO instants), tz, model,
 * locationId, channel, campaign, currency, includeTest, refundsBy (refund_date | order_date).
 */
export async function readParams(req, workspaceId, { defaultDays = 30 } = {}) {
    const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
    if (!workspace) throw new RangeInputError("Workspace not found");
    const q = req.query ?? {};
    const tz = q.tz || workspace.timezone || "UTC";
    if (!isValidTimeZone(tz)) throw new RangeInputError("tz must be an IANA timezone, e.g. Asia/Kolkata");

    const model = q.model ? String(q.model) : workspace.defaultModel || DEFAULT_MODEL;
    if (!ATTRIBUTION_MODELS.includes(model)) throw new RangeInputError(`model must be one of: ${ATTRIBUTION_MODELS.join(", ")}`);
    const currency = q.currency ? String(q.currency).toUpperCase() : workspace.reportingCurrency || "USD";
    if (!/^[A-Z]{3}$/.test(currency)) throw new RangeInputError("currency must be a 3-letter ISO code");

    const today = localDateString(new Date(), tz);
    const isDateOnly = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    let range;
    if ((q.from === undefined || isDateOnly(q.from)) && (q.to === undefined || isDateOnly(q.to))) {
        const toDay = q.to ? dayStr(parseDateOnly(q.to) ?? fail("to")) : today;
        const fromDay = q.from ? dayStr(parseDateOnly(q.from) ?? fail("from")) : shiftDay(toDay, -(defaultDays - 1));
        if (fromDay > toDay) throw new RangeInputError("from must be on or before to");
        if (dayDiff(fromDay, toDay) > 731) throw new RangeInputError("The date range can be at most 2 years");
        range = {
            dayAligned: true,
            fromDay,
            toDay,
            fromDate: new Date(localMidnightUtc(parseDay(fromDay), tz)),
            toDate: new Date(localMidnightUtc(parseDay(shiftDay(toDay, 1)), tz) - 1),
        };
    } else {
        const fromDate = new Date(q.from);
        const toDate = new Date(q.to ?? Date.now());
        if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime())) throw new RangeInputError("from/to must be YYYY-MM-DD or ISO timestamps");
        if (fromDate > toDate) throw new RangeInputError("from must be before to");
        range = { dayAligned: false, fromDay: localDateString(fromDate, tz), toDay: localDateString(toDate, tz), fromDate, toDate };
    }

    // users limited to some locations only ever see those (scope 2: "optionally limited to certain locations")
    const allowed = req.user?.allowedLocationIds ?? [];
    let locationIds = q.locationId ? [String(q.locationId)] : null;
    if (allowed.length) {
        if (q.locationId && !allowed.includes(String(q.locationId))) throw Object.assign(new Error("You do not have access to this location"), { statusCode: 403, code: "forbidden" });
        locationIds = q.locationId ? [String(q.locationId)] : [...allowed];
    }

    return {
        workspace,
        tz,
        model,
        currency,
        range,
        locationIds,
        locationId: locationIds?.length === 1 ? locationIds[0] : null,
        channel: q.channel || null,
        campaign: q.campaign || null,
        includeTest: q.includeTest === "true",
        refundsBy: q.refundsBy === "order_date" ? "order_date" : "refund_date",
    };
}

function fail(name) {
    throw new RangeInputError(`${name} must be a valid date (YYYY-MM-DD)`);
}
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** Same-length window just before the current one (for "change vs previous period"). */
export function previousRange(range, tz) {
    if (range.dayAligned) {
        const len = dayDiff(range.fromDay, range.toDay) + 1;
        const toDay = shiftDay(range.fromDay, -1);
        const fromDay = shiftDay(toDay, -(len - 1));
        return {
            dayAligned: true,
            fromDay,
            toDay,
            fromDate: new Date(localMidnightUtc(parseDay(fromDay), tz)),
            toDate: new Date(localMidnightUtc(parseDay(range.fromDay), tz) - 1),
        };
    }
    const len = range.toDate - range.fromDate;
    const toDate = new Date(range.fromDate.getTime() - 1);
    const fromDate = new Date(toDate.getTime() - len);
    return { dayAligned: false, fromDate, toDate, fromDay: localDateString(fromDate, tz), toDay: localDateString(toDate, tz) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Facts
// ─────────────────────────────────────────────────────────────────────────────

/** Converts minor units of an order's currency to the target currency (stored FX snapshot first). */
function makeConverter(client, target) {
    const cache = new Map();
    return async (minor, currency, day, storedRate, storedQuote) => {
        const amount = BigInt(minor ?? 0);
        if (currency === target) return amount;
        let rate = storedRate !== null && storedRate !== undefined && storedQuote === target ? Number(storedRate) : null;
        if (rate === null) {
            const key = `${day}|${currency}`;
            if (!cache.has(key)) cache.set(key, await findRate(client.orm.public, day, currency, target));
            rate = cache.get(key);
        }
        if (!(rate > 0)) return null;
        const expDiff = currencyExponent(target) - currencyExponent(currency);
        const factor = rate * 10 ** expDiff;
        // fixed-point multiply with half-up rounding
        const scaled = amount * BigInt(Math.round(factor * 1e9));
        const q = scaled / 1_000_000_000n;
        const r = scaled % 1_000_000_000n;
        return r * 2n >= 1_000_000_000n ? q + 1n : r * 2n <= -1_000_000_000n ? q - 1n : q;
    };
}

/**
 * Loads everything a report needs for a range, already bucketed into local days and converted.
 * `withCredits` loads credits for `models` (default: the selected model only).
 */
export async function loadFacts(workspaceId, params, { withCredits = true, models = null, withBookings = true, withTouches = false, client = db } = {}) {
    const t = tenantDb(client, workspaceId);
    const { workspace, tz, currency, range, includeTest } = params;
    const locations = await t.Location.all();
    const locTz = new Map(locations.map((l) => [l.id, l.timezone && isValidTimeZone(l.timezone) ? l.timezone : tz]));
    const dayOf = (instant, locationId) => localDateString(new Date(instant), (locationId && locTz.get(locationId)) || tz);

    // widen by 30h: a location's local day may start up to ~26h away from the company's
    const lo = new Date(range.fromDate.getTime() - 30 * 3600_000).toISOString();
    const hi = new Date(range.toDate.getTime() + 30 * 3600_000).toISOString();
    const inRange = (instant, day) =>
        range.dayAligned ? day >= range.fromDay && day <= range.toDay : new Date(instant) >= range.fromDate && new Date(instant) <= range.toDate;

    const convert = makeConverter(client, currency);
    const warnings = { missingFxOrders: 0, missingFxCurrencies: new Set() };

    const orderRows = await t.Order.where((o) => o.orderedAt.gte(lo)).where((o) => o.orderedAt.lte(hi)).all();
    const orders = [];
    for (const o of orderRows) {
        if (!PAID_STATUSES.includes(o.status) || (!includeTest && o.isTest)) continue;
        const day = dayOf(o.orderedAt, o.locationId);
        if (!inRange(o.orderedAt, day)) continue;
        const utcDay = String(o.orderedAt).slice(0, 10);
        const c = (v) => convert(v, o.currency || currency, utcDay, o.fxRateToReporting, o.reportingCurrency);
        // legacy rows without a gross amount: gross = net + discount
        const grossMinor = o.grossMinorUnits ?? BigInt(o.netMinorUnits ?? 0) + BigInt(o.discountMinorUnits ?? 0);
        const [gross, discount, tax] = await Promise.all([c(grossMinor), c(o.discountMinorUnits), c(o.taxMinorUnits)]);
        if (gross === null) {
            warnings.missingFxOrders++;
            warnings.missingFxCurrencies.add(o.currency);
            continue;
        }
        orders.push({
            id: o.id,
            day,
            orderedAt: o.orderedAt,
            locationId: o.locationId ?? null,
            customerId: o.customerId ?? null,
            isNew: Boolean(o.customerId && o.isNewCustomer),
            matchMethod: o.matchMethod || "none",
            gross: workspace.taxIncludedInRevenue ? gross + tax : gross,
            discount,
            tax,
            net: (workspace.taxIncludedInRevenue ? gross + tax : gross) - discount,
            bookingId: o.bookingId ?? null,
            raw: o,
        });
    }

    // refunds dated in the period (or, with refundsBy=order_date, refunds of the period's orders)
    const refunds = [];
    const refundOrderCache = new Map();
    const refundRows =
        params.refundsBy === "order_date"
            ? (await Promise.all(orders.map((o) => t.Refund.where({ orderId: o.id }).all()))).flat()
            : await t.Refund.where((r) => r.refundedAt.gte(lo)).where((r) => r.refundedAt.lte(hi)).all();
    for (const r of refundRows) {
        let order = refundOrderCache.get(r.orderId);
        if (order === undefined) {
            order = (await t.Order.where({ id: r.orderId }).first()) ?? null;
            refundOrderCache.set(r.orderId, order);
        }
        if (!order || (!includeTest && order.isTest)) continue;
        const day = params.refundsBy === "order_date" ? dayOf(order.orderedAt, order.locationId) : dayOf(r.refundedAt, order.locationId);
        if (params.refundsBy !== "order_date" && !inRange(r.refundedAt, day)) continue;
        const amount = await convert(r.amountMinorUnits, r.currency || order.currency || currency, String(order.orderedAt).slice(0, 10), order.fxRateToReporting, order.reportingCurrency);
        if (amount === null) continue;
        refunds.push({ id: r.id, day, refundedAt: r.refundedAt, orderId: order.id, locationId: order.locationId ?? null, isNew: Boolean(order.customerId && order.isNewCustomer), amount, order });
    }

    // credits: for the period's orders (revenue) and for refunded orders (refund reversal)
    const creditsByOrder = new Map();
    const creditsByBooking = new Map();
    if (withCredits) {
        const wanted = models ?? [params.model];
        for (const model of wanted) {
            const rows = await t.AttributionCredit.where({ model }).all();
            for (const cr of rows) {
                const key = cr.orderId ?? cr.bookingId;
                const map = cr.orderId ? creditsByOrder : creditsByBooking;
                if (!key) continue;
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(cr);
            }
        }
    }

    let bookings = [];
    if (withBookings) {
        const rows = await t.Booking.all();
        for (const b of rows) {
            if (!includeTest && b.isTest) continue;
            const bookedAt = b.bookedAt ?? b.createdAt;
            const day = dayOf(bookedAt, b.locationId);
            const apptDay = dayOf(b.appointmentStartAt, b.locationId);
            const value = await convert(b.bookedValueMinorUnits, b.currency || currency, String(bookedAt).slice(0, 10), null, null);
            bookings.push({ id: b.id, day, apptDay, bookedAt, inPeriod: inRange(bookedAt, day), apptInPeriod: inRange(b.appointmentStartAt, apptDay), value: value ?? 0n, raw: b });
        }
    }

    let touchesById = new Map();
    if (withTouches) {
        const ids = new Set();
        for (const list of creditsByOrder.values()) for (const c of list) if (c.touchId) ids.add(c.touchId);
        for (const id of ids) {
            const touch = await t.Touch.where({ id }).first();
            if (touch) touchesById.set(id, touch);
        }
    }

    return {
        workspace,
        currency,
        tz,
        locations,
        orders: filterByLocation(orders, params.locationIds ?? (params.locationId ? [params.locationId] : null)),
        refunds: filterByLocation(refunds, params.locationIds ?? (params.locationId ? [params.locationId] : null)),
        bookings: filterByLocation(bookings.map((b) => ({ ...b, locationId: b.raw.locationId ?? null })), params.locationIds ?? (params.locationId ? [params.locationId] : null)),
        creditsByOrder,
        creditsByBooking,
        touchesById,
        warnings: { missingFxOrders: warnings.missingFxOrders, missingFxCurrencies: [...warnings.missingFxCurrencies] },
    };
}

const filterByLocation = (rows, locationIds) => (locationIds?.length ? rows.filter((r) => locationIds.includes(r.locationId)) : rows);

/** For list endpoints: the location ids a user may see (null = all). */
export function allowedLocationFilter(req) {
    const allowed = req.user?.allowedLocationIds ?? [];
    return allowed.length ? new Set(allowed) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Credit maths
// ─────────────────────────────────────────────────────────────────────────────

const channelOf = (c) => c.channel ?? (c.touchId ? "direct" : UNATTRIBUTED_CHANNEL);
const campaignOf = (c) => c.campaign ?? "(none)";

/**
 * Credit lines in the reporting currency: one per (order, credit) for revenue, and negative lines for
 * refunds split with the original order's shares. Each line: { orderId, day, locationId, isNew,
 * channel, campaign, share, amount (BigInt, signed), kind: "sale"|"refund" }.
 */
export function creditLines(facts, model) {
    const lines = [];
    const forModel = (orderId) => (facts.creditsByOrder.get(orderId) ?? []).filter((c) => c.model === model).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const split = (total, credits) => {
        if (!credits.length) return [{ c: { channel: UNATTRIBUTED_CHANNEL, campaign: null, share: 1 }, amount: total }];
        const amounts = allocateMinor(total, credits.map((c) => Number(c.share)));
        return credits.map((c, i) => ({ c, amount: amounts[i] }));
    };
    for (const o of facts.orders) {
        for (const { c, amount } of split(o.net, forModel(o.id))) {
            lines.push({ orderId: o.id, day: o.day, locationId: o.locationId, isNew: o.isNew, channel: channelOf(c), campaign: campaignOf(c), share: Number(c.share), amount, kind: "sale", touchId: c.touchId ?? null });
        }
    }
    for (const r of facts.refunds) {
        for (const { c, amount } of split(r.amount, forModel(r.orderId))) {
            lines.push({ orderId: r.orderId, day: r.day, locationId: r.locationId, isNew: r.isNew, channel: channelOf(c), campaign: campaignOf(c), share: Number(c.share), amount: -amount, kind: "refund", touchId: c.touchId ?? null });
        }
    }
    return lines;
}

const sum = (rows, f) => rows.reduce((s, r) => s + BigInt(f(r) ?? 0n), 0n);
const pct = (num, den) => (Number(den) > 0 ? Math.round((Number(num) / Number(den)) * 10000) / 100 : 0);
const ratio = (num, den) => (Number(den) > 0 ? Number(num) / Number(den) : null);
const s = (v) => (typeof v === "bigint" ? v.toString() : v);

// ─────────────────────────────────────────────────────────────────────────────
// Report builders (pure: facts in, JSON out)
// ─────────────────────────────────────────────────────────────────────────────

export function summarize(facts, params) {
    const { orders, refunds, bookings } = facts;
    const gross = sum(orders, (o) => o.gross);
    const discounts = sum(orders, (o) => o.discount);
    const tax = sum(orders, (o) => o.tax);
    const refundTotal = sum(refunds, (r) => r.amount);
    const net = gross - discounts - refundTotal;

    const newCust = new Set(orders.filter((o) => o.isNew).map((o) => o.customerId));
    const anyCust = new Set(orders.filter((o) => o.customerId).map((o) => o.customerId));
    const returningCust = new Set([...anyCust].filter((c) => !newCust.has(c)));
    const perCustomer = new Map();
    for (const o of orders) if (o.customerId) perCustomer.set(o.customerId, (perCustomer.get(o.customerId) ?? 0) + 1);
    const repeaters = [...perCustomer.values()].filter((n) => n >= 2).length;

    const newOrderIds = new Set(orders.filter((o) => o.isNew).map((o) => o.id));
    const newCustomerRevenue = sum(orders.filter((o) => o.isNew), (o) => o.net) - sum(refunds.filter((r) => newOrderIds.has(r.orderId)), (r) => r.amount);

    // coverage, by match method (revenue before refunds, so it does not swing with refund timing)
    const byMethod = {};
    for (const o of orders) {
        const m = (byMethod[o.matchMethod] ??= { matchMethod: o.matchMethod, orders: 0, revenueMinorUnits: 0n });
        m.orders++;
        m.revenueMinorUnits += o.net;
    }
    const preRefund = sum(orders, (o) => o.net);
    const matched = preRefund - (byMethod.none?.revenueMinorUnits ?? 0n);

    const lines = creditLines(facts, params.model);
    const attributed = sum(lines.filter((l) => l.channel !== UNATTRIBUTED_CHANNEL), (l) => l.amount);

    const created = bookings.filter((b) => b.inPeriod);
    const cancelled = created.filter((b) => b.raw.status === "cancelled").length;
    const now = new Date();
    const pastScheduled = created.filter((b) => new Date(b.raw.appointmentStartAt) < now && b.raw.status !== "cancelled");
    const noShows = pastScheduled.filter((b) => b.raw.status === "no_show").length;
    const openBookings = created.filter((b) => ["scheduled", "confirmed", "rescheduled"].includes(b.raw.status));
    const leadHours = created.map((b) => (new Date(b.raw.appointmentStartAt) - new Date(b.bookedAt)) / 3600_000).filter((h) => Number.isFinite(h) && h >= 0);

    return {
        revenue: {
            grossMinorUnits: s(gross),
            discountsMinorUnits: s(discounts),
            taxMinorUnits: s(tax),
            refundsMinorUnits: s(refundTotal),
            netMinorUnits: s(net),
            realizedMinorUnits: s(net),
            averageOrderValueMinorUnits: s(orders.length ? net / BigInt(orders.length) : 0n),
            newCustomerRevenueMinorUnits: s(newCustomerRevenue),
        },
        orders: {
            total: orders.length,
            newCustomers: newCust.size,
            returningCustomers: returningCust.size,
            unidentifiedOrders: orders.filter((o) => !o.customerId).length,
            repeatRate: pct(repeaters, anyCust.size),
            refundCount: refunds.length,
        },
        attribution: {
            model: params.model,
            attributedRevenueMinorUnits: s(attributed),
            coverageRate: pct(matched, preRefund),
            matchedRevenueMinorUnits: s(matched),
            byMatchMethod: Object.values(byMethod).map((m) => ({ ...m, revenueMinorUnits: s(m.revenueMinorUnits), share: pct(m.revenueMinorUnits, preRefund) })),
        },
        bookings: {
            total: created.length,
            scheduled: openBookings.length,
            cancelled,
            noShow: noShows,
            completed: created.filter((b) => b.raw.status === "completed").length,
            bookedValueMinorUnits: s(sum(openBookings, (b) => b.value)),
            cancellationRate: pct(cancelled, created.length),
            noShowRate: pct(noShows, pastScheduled.length),
            averageLeadTimeHours: leadHours.length ? Math.round((leadHours.reduce((a, b) => a + b, 0) / leadHours.length) * 10) / 10 : null,
            newGuests: created.filter((b) => b.raw.customerId && b.raw.isNewCustomer).length,
        },
    };
}

/** Rows grouped by `keyFn(line)` with revenue, credited orders and new customers. */
function groupCredits(facts, model, keyFn, extra = () => ({})) {
    const lines = creditLines(facts, model);
    const orderById = new Map(facts.orders.map((o) => [o.id, o]));
    const groups = new Map();
    for (const l of lines) {
        const key = keyFn(l);
        const g = groups.get(key) ?? { key, revenue: 0n, refunds: 0n, creditedOrders: 0, creditedNewCustomers: 0, orderIds: new Set(), ...extra(l) };
        g.revenue += l.amount;
        if (l.kind === "refund") g.refunds += -l.amount;
        if (l.kind === "sale") {
            g.creditedOrders += l.share;
            if (l.isNew) g.creditedNewCustomers += l.share;
            g.orderIds.add(l.orderId);
        }
        groups.set(key, g);
    }
    return { groups, orderById };
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Average days from the first touch of the journey to the order, per group. */
function avgDaysToConvert(orderIds, facts, orderById) {
    const vals = [];
    for (const id of orderIds) {
        const o = orderById.get(id);
        const credits = (facts.creditsByOrder.get(id) ?? []).filter((c) => c.touchId);
        const times = credits.map((c) => facts.touchesById.get(c.touchId)?.touchedAt).filter(Boolean).map((v) => new Date(v).getTime());
        if (o && times.length) vals.push((new Date(o.orderedAt) - Math.min(...times)) / DAY_MS);
    }
    return vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
}

export function channelRows(facts, params, spendByChannel = new Map()) {
    const { groups, orderById } = groupCredits(facts, params.model, (l) => l.channel);
    const rows = [];
    for (const g of groups.values()) {
        const spend = spendByChannel.get(g.key) ?? null;
        const ordersCount = round2(g.creditedOrders);
        rows.push({
            channel: g.key,
            orders: ordersCount,
            netMinorUnits: s(g.revenue),
            refundsMinorUnits: s(g.refunds),
            newCustomers: round2(g.creditedNewCustomers),
            returningCustomers: round2(g.creditedOrders - g.creditedNewCustomers),
            averageOrderValueMinorUnits: s(ordersCount > 0 ? BigInt(Math.round(Number(g.revenue) / ordersCount)) : 0n),
            spendMinorUnits: spend === null ? null : s(spend),
            cacMinorUnits: spend !== null && g.creditedNewCustomers > 0 ? s(BigInt(Math.round(Number(spend) / g.creditedNewCustomers))) : null,
            roas: spend !== null && Number(spend) > 0 ? round2(Number(g.revenue) / Number(spend)) : null,
            averageDaysToConvert: facts.touchesById.size ? avgDaysToConvert(g.orderIds, facts, orderById) : null,
        });
    }
    // channels with spend but no attributed revenue still show up (CAC = spend / 0 new customers -> null)
    for (const [channel, spend] of spendByChannel) {
        if (!groups.has(channel)) {
            rows.push({ channel, orders: 0, netMinorUnits: "0", refundsMinorUnits: "0", newCustomers: 0, returningCustomers: 0, averageOrderValueMinorUnits: "0", spendMinorUnits: s(spend), cacMinorUnits: null, roas: 0, averageDaysToConvert: null });
        }
    }
    return rows.sort((a, b) => Number(BigInt(b.netMinorUnits) - BigInt(a.netMinorUnits)));
}

export function campaignRows(facts, params, spendByCampaign = new Map()) {
    const { groups } = groupCredits(facts, params.model, (l) => `${l.channel}::${l.campaign}`, (l) => ({ channel: l.channel, campaign: l.campaign }));
    const rows = [...groups.values()].map((g) => {
        const spend = spendByCampaign.get(`${g.channel}::${g.campaign}`) ?? null;
        return {
            channel: g.channel,
            campaign: g.campaign,
            orders: round2(g.creditedOrders),
            netMinorUnits: s(g.revenue),
            newCustomers: round2(g.creditedNewCustomers),
            spendMinorUnits: spend === null ? null : s(spend),
            cacMinorUnits: spend !== null && g.creditedNewCustomers > 0 ? s(BigInt(Math.round(Number(spend) / g.creditedNewCustomers))) : null,
            roas: spend !== null && Number(spend) > 0 ? round2(Number(g.revenue) / Number(spend)) : null,
        };
    });
    for (const [key, spend] of spendByCampaign) {
        if (!groups.has(key)) {
            const [channel, campaign] = key.split("::");
            rows.push({ channel, campaign, orders: 0, netMinorUnits: "0", newCustomers: 0, spendMinorUnits: s(spend), cacMinorUnits: null, roas: 0 });
        }
    }
    return rows.sort((a, b) => Number(BigInt(b.netMinorUnits) - BigInt(a.netMinorUnits)));
}

export function locationRows(facts, params, spendByLocation = new Map()) {
    const names = new Map(facts.locations.map((l) => [l.id, l]));
    const keys = new Set([...facts.orders.map((o) => o.locationId), ...facts.refunds.map((r) => r.locationId), ...facts.bookings.filter((b) => b.inPeriod).map((b) => b.locationId), ...facts.locations.map((l) => l.id)]);
    const lines = creditLines(facts, params.model);
    const rows = [];
    for (const key of keys) {
        const orders = facts.orders.filter((o) => o.locationId === key);
        const refunds = facts.refunds.filter((r) => r.locationId === key);
        const net = sum(orders, (o) => o.gross - o.discount) - sum(refunds, (r) => r.amount);
        const newC = new Set(orders.filter((o) => o.isNew).map((o) => o.customerId));
        const allC = new Set(orders.filter((o) => o.customerId).map((o) => o.customerId));
        const bySource = new Map();
        for (const l of lines.filter((x) => x.locationId === key)) bySource.set(l.channel, (bySource.get(l.channel) ?? 0n) + l.amount);
        const top = [...bySource.entries()].sort((a, b) => Number(b[1] - a[1])).slice(0, 3).map(([channel, v]) => ({ channel, netMinorUnits: s(v) }));
        const bookings = facts.bookings.filter((b) => b.inPeriod && b.locationId === key);
        const loc = key ? names.get(key) : null;
        rows.push({
            locationId: key,
            locationName: loc?.name ?? "(No location)",
            timezone: loc?.timezone ?? facts.tz,
            orders: orders.length,
            netMinorUnits: s(net),
            newCustomers: newC.size,
            returningCustomers: [...allC].filter((c) => !newC.has(c)).length,
            bookings: bookings.length,
            bookedValueMinorUnits: s(sum(bookings.filter((b) => ["scheduled", "confirmed", "rescheduled"].includes(b.raw.status)), (b) => b.value)),
            topSources: top,
            // CAC per location needs spend tagged to that location (AdSpend.locationId, e.g. from CSV upload)
            spendMinorUnits: spendByLocation.has(key) ? s(spendByLocation.get(key)) : null,
            cacMinorUnits: spendByLocation.has(key) && newC.size > 0 ? s(spendByLocation.get(key) / BigInt(newC.size)) : null,
        });
    }
    return rows
        .filter((r) => r.locationId !== null || r.orders > 0 || r.bookings > 0)
        .sort((a, b) => Number(BigInt(b.netMinorUnits) - BigInt(a.netMinorUnits)))
        .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Daily trend in local days (company day; per-location days when filtered to a location). */
export function trendRows(facts, params) {
    const days = new Map();
    const ensure = (d) => days.get(d) ?? days.set(d, { date: d, orders: 0, gross: 0n, discount: 0n, refunds: 0n, newCustomers: 0, bookings: 0 }).get(d);
    if (params.range.dayAligned) for (let d = params.range.fromDay; d <= params.range.toDay; d = shiftDay(d, 1)) ensure(d);
    for (const o of facts.orders) {
        const e = ensure(o.day);
        e.orders++;
        e.gross += o.gross;
        e.discount += o.discount;
        if (o.isNew) e.newCustomers++;
    }
    for (const r of facts.refunds) ensure(r.day).refunds += r.amount;
    for (const b of facts.bookings) if (b.inPeriod) ensure(b.day).bookings++;
    return [...days.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((e) => ({
            date: e.date,
            orders: e.orders,
            grossMinorUnits: s(e.gross),
            refundsMinorUnits: s(e.refunds),
            netMinorUnits: s(e.gross - e.discount - e.refunds),
            newCustomers: e.newCustomers,
            bookings: e.bookings,
        }));
}

/** The same channel under every model, side by side (channels screen comparison view). */
export function modelComparison(facts) {
    const out = new Map();
    for (const model of ATTRIBUTION_MODELS) {
        for (const l of creditLines(facts, model)) {
            const row = out.get(l.channel) ?? { channel: l.channel, ...Object.fromEntries(ATTRIBUTION_MODELS.map((m) => [m, 0n])) };
            row[model] += l.amount;
            out.set(l.channel, row);
        }
    }
    return [...out.values()].map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, s(v)])));
}

/**
 * Journeys (5.3): most common channel paths, average touches and days to purchase, assisted
 * conversions (channels in the journey that were not the last touch).
 */
export function journeyStats(facts, { limit = 20 } = {}) {
    const paths = new Map();
    const assisted = new Map();
    let touchesTotal = 0;
    let journeys = 0;
    const days = [];
    for (const o of facts.orders) {
        const credits = (facts.creditsByOrder.get(o.id) ?? []).filter((c) => c.model === "linear" && c.touchId);
        const touches = credits.map((c) => facts.touchesById.get(c.touchId)).filter(Boolean).sort((a, b) => new Date(a.touchedAt) - new Date(b.touchedAt));
        const seq = touches.length ? touches.map((x) => x.channel || "direct") : [UNATTRIBUTED_CHANNEL];
        const collapsed = seq.filter((c, i) => i === 0 || c !== seq[i - 1]);
        const label = `${collapsed.join(" → ")} → purchase`;
        const p = paths.get(label) ?? { path: label, steps: collapsed, orders: 0, revenueMinorUnits: 0n };
        p.orders++;
        p.revenueMinorUnits += o.net;
        paths.set(label, p);
        if (touches.length) {
            journeys++;
            touchesTotal += touches.length;
            days.push((new Date(o.orderedAt) - new Date(touches[0].touchedAt)) / DAY_MS);
            const last = touches[touches.length - 1].channel || "direct";
            for (const ch of new Set(touches.slice(0, -1).map((x) => x.channel || "direct"))) {
                if (ch === last) continue;
                const a = assisted.get(ch) ?? { channel: ch, assistedOrders: 0, assistedRevenueMinorUnits: 0n };
                a.assistedOrders++;
                a.assistedRevenueMinorUnits += o.net;
                assisted.set(ch, a);
            }
        }
    }
    return {
        paths: [...paths.values()].sort((a, b) => b.orders - a.orders || Number(b.revenueMinorUnits - a.revenueMinorUnits)).slice(0, limit).map((p) => ({ ...p, revenueMinorUnits: s(p.revenueMinorUnits) })),
        averageTouches: journeys ? round2(touchesTotal / journeys) : null,
        averageDaysToPurchase: days.length ? round2(days.reduce((a, b) => a + b, 0) / days.length) : null,
        journeysWithTouches: journeys,
        assisted: [...assisted.values()].sort((a, b) => b.assistedOrders - a.assistedOrders).map((a) => ({ ...a, assistedRevenueMinorUnits: s(a.assistedRevenueMinorUnits) })),
    };
}

export { pct, ratio, sum, s as str };
