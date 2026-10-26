// Section 9 of the scope ("how we know it is accurate"), as automated tests against the real
// pipeline (services/ingestion.js), metrics (services/metrics.js) and report handlers.
import "./setup.js";
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, makeRes } from "./fakeDb.js";

const fake = createFakeDb();
mock.module("../src/prisma/db.js", { namedExports: { db: fake.db }, defaultExport: fake.db });

const { ingestOrder, ingestBooking, ingestRefund, reattributeWorkspace } = await import("../services/ingestion.js");
const reports = await import("../controllers/reportsController.js");
const orders = await import("../controllers/orderController.js");
const refunds = await import("../controllers/refundController.js");
const tracking = await import("../controllers/trackingController.js");
const { mergeCustomersHandler } = await import("../controllers/customerController.js");
const { processRawEvent } = await import("../services/eventQueue.js");
const { tenantDb, TenantScopeError } = await import("../services/tenantDb.js");
const { drainJobs, setJobsPaused } = await import("../services/jobs.js");
const { buildCreditRows } = await import("../services/attributionEngine.js");

const T = fake.tables;
const db = fake.db;
const WS = "ws1";

beforeEach(async () => {
    await drainJobs();
    for (const k of Object.keys(T)) T[k] = [];
    T.Workspace = [
        { id: WS, timezone: "Asia/Kolkata", reportingCurrency: "INR", defaultModel: "last_non_direct", lookbackDays: 30, status: "active", weekStart: 1 },
        { id: "ws2", timezone: "UTC", reportingCurrency: "USD", defaultModel: "last_non_direct", lookbackDays: 30, status: "active" },
    ];
    tracking.invalidateTrackingCache(WS);
});

const visitor = async (sdkId, ws = WS) => (await db.orm.public.Visitor.create({ workspaceId: ws, visitorId: sdkId })).id;
const touch = (visitorId, at, extra = {}, ws = WS) =>
    db.orm.public.Touch.create({ workspaceId: ws, visitorId, touchedAt: at, isTest: false, ...extra });
const token = async (visitorId, touchRows, expiresAt = "2026-12-31T00:00:00Z") =>
    (await db.orm.public.CheckoutSession.create({ workspaceId: WS, token: `tok-${Math.random()}`, visitorId, frozenTouches: touchRows.map((x) => ({ id: x.id })), expiresAt })).token;
const report = async (handler, query, ws = WS) => {
    const res = makeRes();
    await handler({ query, workspaceId: ws, user: { role: "company_admin", workspaceId: ws } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
};
const creditsOf = (orderId, model) => T.AttributionCredit.filter((c) => c.orderId === orderId && c.model === model);

// ── 1 ───────────────────────────────────────────────────────────────────────
test("1. Meta click, Google click, then purchase: first touch Meta, last touch Google, linear 50/50 (exact)", async () => {
    const v = await visitor("v-1");
    const meta = await touch(v, "2026-03-01T10:00:00Z", { fbclid: "fb1", source: "facebook", channel: "meta" });
    const google = await touch(v, "2026-03-03T10:00:00Z", { gclid: "g1", source: "google", medium: "cpc", channel: "google" });
    const r = await ingestOrder(WS, { externalId: "o-1", orderedAt: "2026-03-04T10:00:00Z", currency: "INR", grossAmount: "1000.01", checkoutToken: await token(v, [meta, google]) });
    assert.equal(r.statusCode, 201);
    assert.equal(r.body.matchMethod, "token");
    const id = r.body.orderId;
    assert.deepEqual(creditsOf(id, "first_touch").map((c) => c.channel), ["meta"]);
    assert.deepEqual(creditsOf(id, "last_touch").map((c) => c.channel), ["google"]);
    const linear = creditsOf(id, "linear");
    assert.deepEqual(linear.map((c) => [c.channel, c.share]).sort(), [["google", 0.5], ["meta", 0.5]]);
    // 100001 minor units split 50/50 must still add up exactly
    assert.equal(linear.reduce((s, c) => s + c.amountMinorUnits, 0n), 100001n);
    for (const model of ["first_touch", "last_touch", "last_non_direct", "linear", "time_decay", "position_based"]) {
        assert.equal(creditsOf(id, model).reduce((s, c) => s + c.amountMinorUnits, 0n), 100001n, model);
    }
});

// ── 2 ───────────────────────────────────────────────────────────────────────
test("2. The same payment sent twice creates one order (and one set of credits)", async () => {
    const body = { externalId: "pi_dup", orderedAt: "2026-03-04T10:00:00Z", currency: "INR", grossAmount: 500, email: "a@b.co" };
    const a = await ingestOrder(WS, body);
    const b = await ingestOrder(WS, body);
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 200);
    assert.equal(b.body.status, "already_processed");
    assert.equal(T.Order.length, 1);
    assert.equal(T.AttributionCredit.length, 6, "one unattributed row per model, not twelve");
});

// ── 3 ───────────────────────────────────────────────────────────────────────
test("3. A refund reduces net revenue on ITS date, is linked to the original order, and reduces channel revenue by the order's shares", async () => {
    const v = await visitor("v-3");
    const g = await touch(v, "2026-03-01T10:00:00Z", { gclid: "g3", channel: "google" });
    const o = await ingestOrder(WS, { externalId: "o-3", orderedAt: "2026-03-02T06:00:00Z", currency: "INR", grossAmount: 1000, checkoutToken: await token(v, [g]) });
    const r = await ingestRefund(WS, { externalOrderId: "o-3", amount: 400, currency: "INR", refundedAt: "2026-03-10T06:00:00Z", externalId: "re-1" });
    assert.equal(r.statusCode, 201);
    assert.equal(T.Refund[0].orderId, o.body.orderId);
    assert.equal(T.Order[0].status, "partially_refunded");

    const saleDay = await report(reports.getSummaryReport, { from: "2026-03-02", to: "2026-03-02" });
    assert.equal(saleDay.revenue.netMinorUnits, "100000");
    const refundDay = await report(reports.getSummaryReport, { from: "2026-03-10", to: "2026-03-10" });
    assert.equal(refundDay.revenue.refundsMinorUnits, "40000");
    assert.equal(refundDay.revenue.netMinorUnits, "-40000");
    const both = await report(reports.getChannelsReport, { from: "2026-03-01", to: "2026-03-31" });
    assert.equal(both.data.find((c) => c.channel === "google").netMinorUnits, "60000");
    // toggle: show refunds against the original sale date
    const byOrder = await report(reports.getSummaryReport, { from: "2026-03-02", to: "2026-03-02", refundsBy: "order_date" });
    assert.equal(byOrder.revenue.netMinorUnits, "60000");
    // a refund larger than what is left is refused
    await assert.rejects(ingestRefund(WS, { externalOrderId: "o-3", amount: 700, currency: "INR" }), /exceeds/);

    // the refunds list shows it on its own date, with the order and the order's source
    const list = await report(refunds.listRefunds, { from: "2026-03-10", to: "2026-03-10" });
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].amountMinorUnits, "40000");
    assert.equal(list.data[0].orderExternalId, "o-3");
    assert.equal(list.data[0].source, "google");
    assert.equal(list.totals.amountMinorUnits, "40000");
    assert.equal((await report(refunds.listRefunds, { from: "2026-03-02", to: "2026-03-02" })).data.length, 0);
    assert.equal((await report(refunds.listRefunds, { channel: "meta" })).data.length, 0);
    // another company never sees it
    assert.equal((await report(refunds.listRefunds, {}, "ws2")).data.length, 0);
});

// ── 4 ───────────────────────────────────────────────────────────────────────
test("4. A customer merge combines orders, recalculates new vs returning and re-attributes", async () => {
    const a = await ingestOrder(WS, { externalId: "o-4a", orderedAt: "2026-03-01T10:00:00Z", currency: "INR", grossAmount: 100, email: "first@x.co" });
    const b = await ingestOrder(WS, { externalId: "o-4b", orderedAt: "2026-03-05T10:00:00Z", currency: "INR", grossAmount: 100, email: "second@x.co" });
    assert.equal(a.body.isNewCustomer, true);
    assert.equal(b.body.isNewCustomer, true, "two different people as far as we know");
    // the second identity had a tracked Google visit
    const v = await visitor("v-4");
    await touch(v, "2026-03-04T10:00:00Z", { gclid: "g4", channel: "google" });
    T.Visitor.find((x) => x.id === v).customerId = b.body.customerId;

    const res = makeRes();
    await mergeCustomersHandler({ body: { sourceId: b.body.customerId, targetId: a.body.customerId }, user: { id: "u1", workspaceId: WS, role: "company_admin" }, headers: {}, ip: "1.1.1.1" }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const later = T.Order.find((o) => o.externalId === "o-4b");
    assert.equal(later.customerId, a.body.customerId);
    assert.equal(later.isNewCustomer, false, "the later order is now from a returning customer");
    assert.equal(later.matchMethod, "email", "re-attributed with the merged visitor's touches");
    assert.equal(creditsOf(later.id, "last_touch")[0].channel, "google");
});

// ── 5 ───────────────────────────────────────────────────────────────────────
test("5. Revenue for a day is local midnight to midnight, across a daylight-saving change", async () => {
    T.Workspace[0].timezone = "America/New_York";
    T.Workspace[0].reportingCurrency = "USD";
    const at = ["2026-03-08T04:59:59Z", "2026-03-08T05:00:00Z", "2026-03-09T03:59:59Z", "2026-03-09T04:00:00Z"];
    for (const [i, t] of at.entries()) await ingestOrder(WS, { externalId: `dst-${i}`, orderedAt: t, currency: "USD", grossAmount: 10 });
    const day = await report(reports.getSummaryReport, { from: "2026-03-08", to: "2026-03-08" });
    assert.equal(day.orders.total, 2, "only the two orders inside the 23-hour local day");
    assert.equal(day.revenue.netMinorUnits, "2000");
});

// ── 6 ───────────────────────────────────────────────────────────────────────
test("6. Company A can never read company B's data (data-access layer + reports + lists)", async () => {
    await ingestOrder("ws2", { externalId: "secret-b", orderedAt: "2026-03-04T10:00:00Z", currency: "USD", grossAmount: 999 });
    const tA = tenantDb(db, WS);
    const bOrder = T.Order[0];
    assert.equal(await tA.Order.where({ id: bOrder.id }).first(), null, "a foreign id looks like 'not found'");
    assert.throws(() => tA.Order.where({ workspaceId: "ws2" }), TenantScopeError);
    await assert.rejects(tA.Order.create({ workspaceId: "ws2", externalId: "x" }), TenantScopeError);
    assert.deepEqual(await tA.Order.all(), []);

    const s = await report(reports.getSummaryReport, { from: "2026-03-01", to: "2026-03-31" });
    assert.equal(s.orders.total, 0);
    const res = makeRes();
    await orders.getOrderAttribution({ params: { id: bOrder.id }, workspaceId: WS, query: {} }, res);
    assert.equal(res.statusCode, 404);
});

// ── 7 ───────────────────────────────────────────────────────────────────────
test("7. Dashboard totals equal the sum of the orders shown when drilled down (and channels add up)", async () => {
    const v = await visitor("v-7");
    const m = await touch(v, "2026-03-01T10:00:00Z", { fbclid: "f7", channel: "meta" });
    await ingestOrder(WS, { externalId: "o7a", orderedAt: "2026-03-02T10:00:00Z", currency: "INR", grossAmount: 333.33, discountAmount: 33.33, checkoutToken: await token(v, [m]) });
    await ingestOrder(WS, { externalId: "o7b", orderedAt: "2026-03-03T10:00:00Z", currency: "INR", grossAmount: 100, email: "z@z.co" });
    await ingestOrder(WS, { externalId: "o7c", orderedAt: "2026-03-03T11:00:00Z", currency: "INR", grossAmount: 50, status: "pending" });
    const q = { from: "2026-03-01", to: "2026-03-31" };
    const summary = await report(reports.getSummaryReport, q);
    const list = makeRes();
    await orders.listOrders({ query: { ...q, status: "paid", limit: "100" }, workspaceId: WS, user: { role: "company_admin", workspaceId: WS } }, list);
    const listed = list.body.data.reduce((s, o) => s + BigInt(o.netMinorUnits), 0n);
    assert.equal(String(listed), summary.revenue.netMinorUnits);
    assert.equal(list.body.data.length, summary.orders.total, "pending orders are in neither");
    const channels = await report(reports.getChannelsReport, q);
    assert.equal(String(channels.data.reduce((s, c) => s + BigInt(c.netMinorUnits), 0n)), summary.revenue.netMinorUnits);
});

// ── 9 ───────────────────────────────────────────────────────────────────────
test("9. Replaying a day of raw events produces identical results", async () => {
    const v = await visitor("v-9");
    const g = await touch(v, "2026-03-01T10:00:00Z", { gclid: "g9", channel: "google" });
    const tok = await token(v, [g]);
    const payloads = [
        { externalId: "r1", orderedAt: "2026-03-02T10:00:00Z", currency: "INR", grossAmount: 120, checkoutToken: tok },
        { externalId: "r2", orderedAt: "2026-03-02T12:00:00Z", currency: "INR", grossAmount: 80, email: "q@q.co" },
    ];
    for (const p of payloads) {
        const raw = await db.orm.public.RawEvent.create({ workspaceId: WS, connectorId: null, source: "api", eventType: "order.paid", payload: p, status: "pending", attempts: 0, receivedAt: "2026-03-02T12:05:00Z" });
        assert.equal(await processRawEvent(raw.id), "processed");
    }
    const snapshot = () => JSON.stringify([T.Order.map((o) => [o.externalId, o.matchMethod, String(o.netMinorUnits)]), T.AttributionCredit.map((c) => [c.model, c.channel, String(c.amountMinorUnits)]).sort()]);
    const before = snapshot();
    for (const raw of T.RawEvent) {
        raw.status = "pending";
        assert.equal(await processRawEvent(raw.id), "processed");
    }
    assert.equal(snapshot(), before);
    assert.equal(T.Order.length, 2);
    // and the attribution re-run tool reproduces the same credits from stored touches
    await reattributeWorkspace(WS);
    assert.equal(snapshot(), before);
});

// ── 10 ──────────────────────────────────────────────────────────────────────
test("10. Attribution coverage = revenue with a matched source ÷ total revenue, broken down by match method", async () => {
    const v = await visitor("v-10");
    const g = await touch(v, "2026-03-01T10:00:00Z", { gclid: "g10", channel: "google" });
    await ingestOrder(WS, { externalId: "c1", orderedAt: "2026-03-02T10:00:00Z", currency: "INR", grossAmount: 300, checkoutToken: await token(v, [g]) });
    await ingestOrder(WS, { externalId: "c2", orderedAt: "2026-03-02T11:00:00Z", currency: "INR", grossAmount: 100 });
    const cov = await report(reports.getCoverageReport, { from: "2026-03-01", to: "2026-03-31" });
    assert.equal(cov.coverageRate, 75);
    assert.deepEqual(cov.byMatchMethod.map((m) => [m.matchMethod, m.revenueMinorUnits]).sort(), [["none", "10000"], ["token", "30000"]]);
    assert.equal(cov.unattributedReasons[0].reason, "no_identifiers");
});

// ── pipeline rules ──────────────────────────────────────────────────────────
test("token rules: used once; an expired token falls back with a reason code; lookback applies to frozen touches", async () => {
    const v = await visitor("v-t");
    const g = await touch(v, "2026-03-01T10:00:00Z", { gclid: "gt", channel: "google" });
    const tok = await token(v, [g], "2026-03-05T00:00:00Z");
    const first = await ingestOrder(WS, { externalId: "t1", orderedAt: "2026-03-02T10:00:00Z", currency: "INR", grossAmount: 10, checkoutToken: tok });
    assert.equal(first.body.matchMethod, "token");
    const reused = await ingestOrder(WS, { externalId: "t2", orderedAt: "2026-03-03T10:00:00Z", currency: "INR", grossAmount: 10, checkoutToken: tok });
    assert.equal(reused.body.matchMethod, "none");
    assert.equal(reused.body.attributionReason, "token_already_used");
    const tok2 = await token(v, [g], "2026-03-05T00:00:00Z");
    const late = await ingestOrder(WS, { externalId: "t3", orderedAt: "2026-03-06T10:00:00Z", currency: "INR", grossAmount: 10, checkoutToken: tok2 });
    assert.equal(late.body.attributionReason, "token_expired");
    T.Workspace[0].lookbackDays = 1;
    const tok3 = await token(v, [g]);
    const old = await ingestOrder(WS, { externalId: "t4", orderedAt: "2026-03-10T10:00:00Z", currency: "INR", grossAmount: 10, checkoutToken: tok3 });
    assert.equal(old.body.matchMethod, "none");
    assert.equal(old.body.attributionReason, "outside_lookback");
});

test("fallbacks: email-linked visitor, then click id (builds a touch), then Direct / unknown with a reason", async () => {
    const v = await visitor("v-f");
    await touch(v, "2026-03-01T10:00:00Z", { source: "newsletter", medium: "email", channel: "email" });
    const idf = makeRes();
    await tracking.identifyVisitor({ workspaceId: WS, body: { visitorId: "v-f", email: "Known@X.co" }, headers: {} }, idf);
    assert.equal(idf.statusCode, 200, JSON.stringify(idf.body));
    const byEmail = await ingestOrder(WS, { externalId: "f1", orderedAt: "2026-03-02T10:00:00Z", currency: "INR", grossAmount: 10, email: "known@x.co" });
    assert.equal(byEmail.body.matchMethod, "email");
    const byClick = await ingestOrder(WS, { externalId: "f2", orderedAt: "2026-03-02T10:00:00Z", currency: "INR", grossAmount: 10, gclid: "never-seen" });
    assert.equal(byClick.body.matchMethod, "click_id");
    assert.equal(creditsOf(byClick.body.orderId, "last_touch")[0].channel, "google");
    const none = await ingestOrder(WS, { externalId: "f3", orderedAt: "2026-03-02T10:00:00Z", currency: "INR", grossAmount: 10, email: "stranger@x.co" });
    assert.equal(none.body.matchMethod, "none");
    assert.equal(none.body.attributionReason, "no_tracked_visits");
    assert.equal(creditsOf(none.body.orderId, "linear")[0].channel, "direct_unknown");
    assert.equal(creditsOf(none.body.orderId, "linear")[0].reasonCode, "no_tracked_visits");
    // anonymous orders do not invent customers
    await ingestOrder(WS, { externalId: "f4", orderedAt: "2026-03-02T10:00:00Z", currency: "INR", grossAmount: 10 });
    assert.equal(T.Order.find((o) => o.externalId === "f4").customerId, null);
});

test("a later direct visit never replaces a paid click; per-channel lookback overrides apply", async () => {
    const v = await visitor("v-d");
    const paid = await touch(v, "2026-03-01T10:00:00Z", { gclid: "gd", channel: "google" });
    const direct = await touch(v, "2026-03-02T10:00:00Z", { channel: "direct" });
    const r = await ingestOrder(WS, { externalId: "d1", orderedAt: "2026-03-02T11:00:00Z", currency: "INR", grossAmount: 10, checkoutToken: await token(v, [paid, direct]) });
    assert.equal(creditsOf(r.body.orderId, "last_touch")[0].channel, "google");
    T.Workspace[0].lookbackOverrides = { email: 2 };
    const v2 = await visitor("v-d2");
    const mail = await touch(v2, "2026-03-01T10:00:00Z", { medium: "email", source: "nl", channel: "email" });
    const r2 = await ingestOrder(WS, { externalId: "d2", orderedAt: "2026-03-05T11:00:00Z", currency: "INR", grossAmount: 10, checkoutToken: await token(v2, [mail]) });
    assert.equal(r2.body.matchMethod, "none", "an email touch older than its 2-day window gets no credit");
});

test("bookings are attributed when created; the invoice inherits the booking's credit", async () => {
    const v = await visitor("v-b");
    const m = await touch(v, "2026-03-01T10:00:00Z", { fbclid: "fbb", channel: "meta" });
    const b = await ingestBooking(WS, { externalId: "appt-1", appointmentStartAt: "2026-03-20T10:00:00Z", bookedAt: "2026-03-01T11:00:00Z", currency: "INR", bookedValue: 2000, checkoutToken: await token(v, [m]) });
    assert.equal(b.body.matchMethod, "token");
    // the invoice arrives weeks later, long after the token expired, with only the appointment id
    const inv = await ingestOrder(WS, { externalId: "inv-1", orderedAt: "2026-03-20T12:00:00Z", currency: "INR", grossAmount: 1800, bookingExternalId: "appt-1" });
    assert.equal(inv.body.bookingId, b.body.bookingId);
    assert.equal(inv.body.matchMethod, "token");
    assert.equal(creditsOf(inv.body.orderId, "last_non_direct")[0].channel, "meta");
    assert.equal(creditsOf(inv.body.orderId, "last_non_direct")[0].amountMinorUnits, 180000n, "credit is on realized revenue, not booked value");
    const bookingsReport = await report(reports.getBookingsReport, { from: "2026-03-01", to: "2026-03-31" });
    assert.equal(bookingsReport.pipeline.paid, 1);
});

test("FX: orders in another currency use the snapshot rate stored at ingestion; missing rates are reported, not guessed", async () => {
    T.FxRate = [{ id: "fx1", date: "2026-03-02", base: "USD", quote: "INR", rate: 83.5 }];
    const usd = await ingestOrder(WS, { externalId: "fx-1", orderedAt: "2026-03-02T10:00:00Z", currency: "USD", grossAmount: 10 });
    assert.equal(usd.body.fxRateToReporting, 83.5);
    T.FxRate[0].rate = 99; // later rate changes never change an old report
    await ingestOrder(WS, { externalId: "fx-2", orderedAt: "2026-03-02T10:00:00Z", currency: "AED", grossAmount: 10 });
    const s = await report(reports.getSummaryReport, { from: "2026-03-02", to: "2026-03-02" });
    assert.equal(s.revenue.netMinorUnits, "83500");
    assert.match(s.warnings[0], /AED/);
});

test("rollups (D8) give the same channel report as the live computation", async () => {
    const { rebuildAll } = await import("../services/rollups.js");
    const v = await visitor("v-r");
    const g = await touch(v, "2026-03-01T10:00:00Z", { gclid: "gr", channel: "google" });
    await ingestOrder(WS, { externalId: "ro1", orderedAt: "2026-03-02T10:00:00Z", currency: "INR", grossAmount: 250, checkoutToken: await token(v, [g]) });
    await ingestOrder(WS, { externalId: "ro2", orderedAt: "2026-03-03T10:00:00Z", currency: "INR", grossAmount: 75 });
    await ingestRefund(WS, { externalOrderId: "ro1", amount: 50, currency: "INR", refundedAt: "2026-03-04T10:00:00Z" });
    await drainJobs();
    const q = { from: "2026-03-01", to: "2026-03-31" };
    process.env.USE_ROLLUPS_FOR_REPORTS = "false";
    const live = await report(reports.getChannelsReport, q);
    delete process.env.USE_ROLLUPS_FOR_REPORTS;
    assert.equal(live.source, "live");
    await rebuildAll(WS);
    const rolled = await report(reports.getChannelsReport, q);
    assert.equal(rolled.source, "rollups");
    const pick = (b) => b.data.map((r) => [r.channel, r.netMinorUnits, r.orders]).sort();
    assert.deepEqual(pick(rolled), pick(live));
    // a new write makes the rollups stale until they are refreshed: never a stale read
    setJobsPaused(true);
    await ingestOrder(WS, { externalId: "ro3", orderedAt: "2026-03-05T10:00:00Z", currency: "INR", grossAmount: 10 });
    assert.equal((await report(reports.getChannelsReport, q)).source, "live");
    setJobsPaused(false);
});

test("credit rows always add up exactly, whatever the number of touches", () => {
    for (let n = 1; n <= 7; n++) {
        const touches = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, channel: i % 2 ? "google" : "meta", touchedAt: new Date(Date.UTC(2026, 2, 1 + i)).toISOString() }));
        const rows = buildCreditRows({ workspaceId: WS, orderId: "o", touches, orderedAt: "2026-03-10T00:00:00Z", netMinorUnits: 99999n, currency: "INR" });
        for (const model of ["first_touch", "last_touch", "last_non_direct", "linear", "time_decay", "position_based"]) {
            assert.equal(rows.filter((r) => r.model === model).reduce((s, r) => s + r.amountMinorUnits, 0n), 99999n, `${model} n=${n}`);
        }
    }
});

test("consent: with opt-in consent nothing is stored until the visitor agreed", async () => {
    T.Workspace[0].consentMode = "opt_in";
    tracking.invalidateTrackingCache(WS);
    const req = (consent) => ({ workspaceId: WS, apiKey: { mode: "live" }, headers: {}, body: { visitorId: "c-1", source: "google", medium: "cpc", consent } });
    let res = makeRes();
    await tracking.recordTouch(req(undefined), res);
    assert.equal(res.statusCode, 202);
    assert.equal(T.Touch.length, 0);
    res = makeRes();
    await tracking.recordTouch(req(true), res);
    assert.equal(res.statusCode, 201);
    assert.equal(T.Touch.length, 1);
});
