// Dynamic FX for sales and bookings: the company chooses "rate of each sale's date" (corrected when that
// day's rate changes) or "today's rate" (everything re-valued as rates move).
import "./setup.js";
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, makeRes } from "./fakeDb.js";

const fake = createFakeDb();
mock.module("../src/prisma/db.js", { namedExports: { db: fake.db }, defaultExport: fake.db });

const { ingestOrder, ingestBooking, ingestRefund } = await import("../services/ingestion.js");
const reports = await import("../controllers/reportsController.js");
const { listUpcomingBookings } = await import("../controllers/bookingController.js");
const { listRefunds } = await import("../controllers/refundController.js");
const { applyRateChanges } = await import("../services/fxRevaluation.js");
const { staleWorkspaceIds } = await import("../services/rollups.js");
const { validateWorkspaceSettings, scheduleRebuildIfNeeded } = await import("../services/workspaceSettings.js");
const { drainJobs, setJobsPaused } = await import("../services/jobs.js");

const T = fake.tables;
const WS = "ws1";
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
};
const rate = (date, value, quote = "INR", base = "USD") => ({ id: `${date}-${base}-${quote}`, date, base, quote, rate: value, source: "frankfurter" });
const setRate = (date, value) => {
    const row = T.FxRate.find((r) => r.date === date && r.base === "USD" && r.quote === "INR");
    if (row) row.rate = value;
    else T.FxRate.push(rate(date, value));
};

beforeEach(async () => {
    await drainJobs();
    setJobsPaused(false);
    for (const k of Object.keys(T)) T[k] = [];
    T.Workspace = [{ id: WS, timezone: "UTC", reportingCurrency: "INR", defaultModel: "last_non_direct", lookbackDays: 30, status: "active", fxRateMode: "transaction_date" }];
});

const report = async (handler, query = {}) => {
    const res = makeRes();
    await handler({ query, headers: {}, workspaceId: WS, user: { role: "company_admin", workspaceId: WS } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
};
const summary = (from, to, extra = {}) => report(reports.getSummaryReport, { from, to, ...extra });

// ── transaction_date mode (default) ─────────────────────────────────────────

test("rate of the sale's date: a sale keeps its day's rate, and is corrected when that day's rate changes", async () => {
    const d = daysAgo(10);
    T.FxRate = [rate(d, 80), rate(today, 90)];
    await ingestOrder(WS, { externalId: "s1", orderedAt: `${d}T10:00:00Z`, currency: "USD", grossAmount: 100 });
    assert.equal(T.Order[0].fxRateToReporting, 80);
    let s = await summary(d, d);
    assert.equal(s.revenue.netMinorUnits, "800000", "100 USD × 80 = 8,000.00 INR");
    assert.equal(s.fx.mode, "transaction_date");

    // today's rate moving does not touch an older sale in this mode
    setRate(today, 95);
    await applyRateChanges([today], ["USD", "INR"]);
    assert.equal(T.Order[0].fxRateToReporting, 80);

    // the ECB corrects that day's rate: the sale follows automatically
    setRate(d, 82);
    const out = await applyRateChanges([d], ["USD", "INR"]);
    assert.equal(out.ordersRepriced, 1);
    assert.equal(T.Order[0].fxRateToReporting, 82);
    s = await summary(d, d);
    assert.equal(s.revenue.netMinorUnits, "820000");
});

test("a sale on a weekend used Friday's rate; when Friday's rate changes the weekend sale follows too", async () => {
    const friday = daysAgo(9);
    const sunday = daysAgo(7); // no rate on this day: falls back to Friday
    T.FxRate = [rate(friday, 80)];
    await ingestOrder(WS, { externalId: "w1", orderedAt: `${sunday}T10:00:00Z`, currency: "USD", grossAmount: 10 });
    assert.equal(T.Order[0].fxRateToReporting, 80);
    setRate(friday, 81);
    await applyRateChanges([friday], ["USD", "INR"]);
    assert.equal(T.Order[0].fxRateToReporting, 81);
});

test("a sale that arrived before its rate existed gets it as soon as the sync brings it", async () => {
    const d = daysAgo(1);
    await ingestOrder(WS, { externalId: "late", orderedAt: `${d}T10:00:00Z`, currency: "USD", grossAmount: 10 });
    assert.equal(T.Order[0].fxRateToReporting ?? null, null);
    const before = await summary(d, d);
    assert.equal(before.revenue.netMinorUnits, "0");
    assert.equal(before.warnings.length, 1, "the report says an order has no rate");
    T.FxRate = [rate(d, 83)];
    await applyRateChanges([d], ["USD", "INR"]);
    assert.equal(T.Order[0].fxRateToReporting, 83);
    assert.equal((await summary(d, d)).revenue.netMinorUnits, "83000");
});

test("a rate change marks the company's rollups stale, so dashboards compute with the new rate", async () => {
    const d = daysAgo(5);
    T.FxRate = [rate(d, 80)];
    await ingestOrder(WS, { externalId: "r1", orderedAt: `${d}T10:00:00Z`, currency: "USD", grossAmount: 10 });
    await drainJobs(); // rollups built
    assert.deepEqual(await staleWorkspaceIds(), []);
    setJobsPaused(true);
    setRate(d, 84);
    await applyRateChanges([d], ["USD", "INR"]);
    assert.deepEqual(await staleWorkspaceIds(), [WS], "rollups are behind until rebuilt");
    const s = await report(reports.getChannelsReport, { from: d, to: d });
    assert.equal(s.source, "live", "never serves amounts at the old rate");
    setJobsPaused(false);
});

test("bookings follow their booking day's rate when it changes (no stored snapshot needed)", async () => {
    const d = daysAgo(3);
    T.FxRate = [rate(d, 80)];
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await ingestBooking(WS, { externalId: "b1", appointmentStartAt: future, bookedAt: `${d}T09:00:00Z`, currency: "USD", bookedValue: 50 });
    assert.equal((await summary(d, d)).bookings.bookedValueMinorUnits, "400000");
    setRate(d, 86);
    const out = await applyRateChanges([d], ["USD", "INR"]);
    assert.equal(out.workspacesRebuilt, 1, "the company's rollups are rebuilt for the booking");
    assert.equal((await summary(d, d)).bookings.bookedValueMinorUnits, "430000");
});

// ── latest mode ─────────────────────────────────────────────────────────────

test("today's rate: every sale and booking is re-valued at the newest rate as soon as it changes", async () => {
    T.Workspace[0].fxRateMode = "latest";
    const old = daysAgo(20);
    T.FxRate = [rate(old, 70), rate(today, 90)];
    await ingestOrder(WS, { externalId: "L1", orderedAt: `${old}T10:00:00Z`, currency: "USD", grossAmount: 100 });
    await ingestOrder(WS, { externalId: "L2", orderedAt: `${old}T11:00:00Z`, currency: "INR", grossAmount: 500 });
    let s = await summary(old, old);
    assert.equal(s.revenue.netMinorUnits, String(900000 + 50000), "100 USD at today's 90, plus 500 INR as is");
    assert.equal(s.fx.mode, "latest");
    assert.equal(s.fx.ratesAsOf, today);

    // the newest rate moves: the old sale is re-valued, nothing is rewritten on the order
    setRate(today, 92);
    const out = await applyRateChanges([today], ["USD", "INR"]);
    assert.equal(out.workspacesRebuilt, 1);
    assert.equal(out.ordersRepriced, 0, "orders are not rewritten in this mode");
    s = await summary(old, old);
    assert.equal(s.revenue.netMinorUnits, String(920000 + 50000));

    // a correction of an old day's rate does not move "today's rate"
    setRate(old, 71);
    assert.equal((await applyRateChanges([old], ["USD", "INR"])).workspacesRebuilt, 0);
});

test("today's rate also applies to refunds and bookings", async () => {
    T.Workspace[0].fxRateMode = "latest";
    const d = daysAgo(15);
    T.FxRate = [rate(d, 70), rate(today, 90)];
    await ingestOrder(WS, { externalId: "R1", orderedAt: `${d}T10:00:00Z`, currency: "USD", grossAmount: 100 });
    await ingestRefund(WS, { externalOrderId: "R1", amount: 10, currency: "USD", refundedAt: `${d}T12:00:00Z` });
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await ingestBooking(WS, { externalId: "B1", appointmentStartAt: future, bookedAt: `${d}T09:00:00Z`, currency: "USD", bookedValue: 20 });
    const s = await summary(d, d);
    assert.equal(s.revenue.refundsMinorUnits, "90000", "10 USD refund at 90");
    assert.equal(s.bookings.bookedValueMinorUnits, "180000", "20 USD booking at 90");
});

test("?fxMode= shows the other view for one report; rollups are only used for the company's own mode", async () => {
    const d = daysAgo(12);
    T.FxRate = [rate(d, 80), rate(today, 90)];
    await ingestOrder(WS, { externalId: "C1", orderedAt: `${d}T10:00:00Z`, currency: "USD", grossAmount: 100 });
    await drainJobs();
    assert.equal((await summary(d, d)).revenue.netMinorUnits, "800000");
    const other = await summary(d, d, { fxMode: "latest" });
    assert.equal(other.revenue.netMinorUnits, "900000");
    assert.equal(other.fx.mode, "latest");
    const ch = await report(reports.getChannelsReport, { from: d, to: d, fxMode: "latest" });
    assert.equal(ch.source, "live");
});

// ── lists that used to add different currencies together ───────────────────

test("upcoming bookings add up in the reporting currency, not raw amounts in mixed currencies", async () => {
    const d = daysAgo(2);
    T.FxRate = [rate(d, 80), rate(today, 90)];
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await ingestBooking(WS, { externalId: "u1", appointmentStartAt: future, bookedAt: `${d}T09:00:00Z`, currency: "USD", bookedValue: 10 });
    await ingestBooking(WS, { externalId: "u2", appointmentStartAt: future, bookedAt: `${d}T09:00:00Z`, currency: "INR", bookedValue: 100 });
    let up = await report(listUpcomingBookings, { days: "7" });
    assert.equal(up.currency, "INR");
    assert.equal(up.bookedValueMinorUnits, String(80000 + 10000), "10 USD at 80 + 100 INR (was 1000 + 10000 before)");
    assert.equal(up.data.find((b) => b.currency === "USD").reportingValueMinorUnits, "80000");
    T.Workspace[0].fxRateMode = "latest";
    up = await report(listUpcomingBookings, { days: "7" });
    assert.equal(up.bookedValueMinorUnits, String(90000 + 10000));
    assert.equal(up.fx.mode, "latest");
});

test("the refunds list total is in the reporting currency", async () => {
    const d = daysAgo(4);
    T.FxRate = [rate(d, 80)];
    await ingestOrder(WS, { externalId: "o-usd", orderedAt: `${d}T10:00:00Z`, currency: "USD", grossAmount: 100 });
    await ingestOrder(WS, { externalId: "o-inr", orderedAt: `${d}T10:00:00Z`, currency: "INR", grossAmount: 1000 });
    await ingestRefund(WS, { externalOrderId: "o-usd", amount: 5, currency: "USD", refundedAt: `${d}T12:00:00Z` });
    await ingestRefund(WS, { externalOrderId: "o-inr", amount: 100, currency: "INR", refundedAt: `${d}T12:00:00Z` });
    const list = await report(listRefunds, {});
    assert.equal(list.totals.currency, "INR");
    assert.equal(list.totals.amountMinorUnits, String(40000 + 10000));
});

// ── setting ─────────────────────────────────────────────────────────────────

test("fxRateMode is a validated company setting, and changing it rebuilds the reports", async () => {
    assert.match(validateWorkspaceSettings({ fxRateMode: "weekly" }), /fxRateMode must be one of/);
    assert.equal(validateWorkspaceSettings({ fxRateMode: "latest" }), null);
    setJobsPaused(true);
    assert.equal(await scheduleRebuildIfNeeded(WS, ["fxRateMode"]), "rollups.rebuild");
    setJobsPaused(false);
});

// ── the hourly job, end to end ──────────────────────────────────────────────

test("the hourly FX job: the provider changes a rate, and the affected sale is re-priced automatically", async () => {
    await import("../services/workers.js"); // registers the fxrates.sync handler (no timers started)
    const { enqueueJob } = await import("../services/jobs.js");
    const d = daysAgo(6);
    let usdInr = 80;
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
        if (!String(input).includes("frankfurter")) return { ok: false, status: 404, json: async () => ({}) }; // no secondary rates in this test
        return { ok: true, status: 200, json: async () => ({ base: "USD", start_date: daysAgo(45), end_date: today, rates: { [d]: { INR: usdInr } } }) };
    };
    try {
        await enqueueJob("fxrates.sync", { day: "t1" });
        await ingestOrder(WS, { externalId: "J1", orderedAt: `${d}T10:00:00Z`, currency: "USD", grossAmount: 100 });
        assert.equal(T.Order[0].fxRateToReporting, 80);

        usdInr = 88; // the ECB revises that day's rate
        const out = await enqueueJob("fxrates.sync", { day: "t2" });
        assert.deepEqual(out.changedDates, [d]);
        assert.equal(out.ordersRepriced, 1);
        assert.equal(T.Order[0].fxRateToReporting, 88);
        assert.equal((await summary(d, d)).revenue.netMinorUnits, "880000");
    } finally {
        globalThis.fetch = original;
    }
});

// ── viewing in another currency ─────────────────────────────────────────────

test("a company reporting in INR can view the same figures in USD (?currency=USD), with either FX mode", async () => {
    const d = daysAgo(8);
    T.FxRate = [rate(d, 80), rate(today, 90)];
    await ingestOrder(WS, { externalId: "V1", orderedAt: `${d}T10:00:00Z`, currency: "INR", grossAmount: 8000 });
    await ingestOrder(WS, { externalId: "V2", orderedAt: `${d}T11:00:00Z`, currency: "USD", grossAmount: 50 });
    const inr = await summary(d, d);
    assert.equal(inr.currency, "INR");
    assert.equal(inr.revenue.netMinorUnits, String(800000 + 400000), "8,000 INR + 50 USD × 80");
    const usd = await summary(d, d, { currency: "USD" });
    assert.equal(usd.currency, "USD");
    assert.equal(usd.revenue.netMinorUnits, String(10000 + 5000), "8,000 INR ÷ 80 = 100 USD, plus 50 USD");
    const usdToday = await summary(d, d, { currency: "USD", fxMode: "latest" });
    assert.equal(usdToday.revenue.netMinorUnits, String(Math.round(800000 / 90) + 5000));
    const up = await report(listRefunds, { currency: "USD" });
    assert.equal(up.totals.currency, "USD");
});
