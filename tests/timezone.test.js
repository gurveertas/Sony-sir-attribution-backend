import "./setup.js";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, makeRes } from "./fakeDb.js";

const tzu = await import("../utils/timezone.js");
const iso = (d) => d.toISOString();

test("isValidTimeZone", () => {
    assert.equal(tzu.isValidTimeZone("Asia/Kolkata"), true);
    assert.equal(tzu.isValidTimeZone("UTC"), true);
    for (const bad of ["Mars/Base", "", null, undefined, "x".repeat(80)]) assert.equal(tzu.isValidTimeZone(bad), false, String(bad));
});

test("local midnight: fixed-offset zones (India +5:30, UTC)", () => {
    assert.equal(iso(new Date(tzu.localMidnightUtc({ y: 2026, m: 1, d: 1 }, "Asia/Kolkata"))), "2025-12-31T18:30:00.000Z");
    assert.equal(iso(new Date(tzu.localMidnightUtc({ y: 2026, m: 1, d: 1 }, "UTC"))), "2026-01-01T00:00:00.000Z");
});

test("DST spring forward (New York, 2026-03-08): the local day is 23 hours long", () => {
    const start = tzu.localMidnightUtc({ y: 2026, m: 3, d: 8 }, "America/New_York");
    const next = tzu.localMidnightUtc({ y: 2026, m: 3, d: 9 }, "America/New_York");
    assert.equal(iso(new Date(start)), "2026-03-08T05:00:00.000Z"); // EST, UTC-5
    assert.equal(iso(new Date(next)), "2026-03-09T04:00:00.000Z"); // EDT, UTC-4
    assert.equal((next - start) / 3600000, 23);
});

test("DST fall back (New York, 2026-11-01): the local day is 25 hours long", () => {
    const start = tzu.localMidnightUtc({ y: 2026, m: 11, d: 1 }, "America/New_York");
    const next = tzu.localMidnightUtc({ y: 2026, m: 11, d: 2 }, "America/New_York");
    assert.equal(iso(new Date(start)), "2026-11-01T04:00:00.000Z");
    assert.equal(iso(new Date(next)), "2026-11-02T05:00:00.000Z");
    assert.equal((next - start) / 3600000, 25);
});

test("30-minute DST zone (Lord Howe) and southern hemisphere (Sydney) boundaries", () => {
    // Lord Howe: +10:30 standard, +11:00 daylight (shift of 30 min). DST ends 2026-04-05, starts 2026-10-04.
    const a = tzu.localMidnightUtc({ y: 2026, m: 4, d: 6 }, "Australia/Lord_Howe"); // after DST ended: +10:30
    assert.equal(iso(new Date(a)), "2026-04-05T13:30:00.000Z");
    const b = tzu.localMidnightUtc({ y: 2026, m: 1, d: 10 }, "Australia/Lord_Howe"); // during DST: +11:00
    assert.equal(iso(new Date(b)), "2026-01-09T13:00:00.000Z");
    assert.equal(iso(new Date(tzu.localMidnightUtc({ y: 2026, m: 7, d: 1 }, "Australia/Sydney"))), "2026-06-30T14:00:00.000Z");
});

test("localDateString + localParts agree with the zone", () => {
    assert.equal(tzu.localDateString(new Date("2026-03-01T18:29:59Z"), "Asia/Kolkata"), "2026-03-01");
    assert.equal(tzu.localDateString(new Date("2026-03-01T18:30:00Z"), "Asia/Kolkata"), "2026-03-02");
    assert.equal(tzu.localDateString(new Date("2026-03-01T04:59:59Z"), "America/New_York"), "2026-02-28");
});

test("parseDateOnly rejects impossible / non-date strings", () => {
    assert.deepEqual(tzu.parseDateOnly("2026-02-28"), { y: 2026, m: 2, d: 28 });
    for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026-1-1", "tomorrow", "2026-01-01T00:00:00Z", "", null]) {
        assert.equal(tzu.parseDateOnly(bad), null, String(bad));
    }
});

test("resolveDateRange: date-only = whole LOCAL days", () => {
    const { fromDate, toDate } = tzu.resolveDateRange({ from: "2026-03-08", to: "2026-03-08", timeZone: "America/New_York" });
    assert.equal(iso(fromDate), "2026-03-08T05:00:00.000Z");
    assert.equal(iso(toDate), "2026-03-09T03:59:59.999Z"); // 23-hour day
    const india = tzu.resolveDateRange({ from: "2026-03-02", to: "2026-03-02", timeZone: "Asia/Kolkata" });
    assert.equal(iso(india.fromDate), "2026-03-01T18:30:00.000Z");
    assert.equal(iso(india.toDate), "2026-03-02T18:29:59.999Z");
});

test("resolveDateRange: full ISO instants are used exactly as given", () => {
    const r = tzu.resolveDateRange({ from: "2026-03-01T10:00:00Z", to: "2026-03-01T17:00:00+05:30", timeZone: "Asia/Kolkata" });
    assert.equal(iso(r.fromDate), "2026-03-01T10:00:00.000Z");
    assert.equal(iso(r.toDate), "2026-03-01T11:30:00.000Z");
});

test("resolveDateRange: default = the last 30 LOCAL days ending today; 'today' follows the company clock", () => {
    // 2026-03-02 01:00 in Kolkata is still 2026-03-01 19:30 UTC -> local today is Mar 2 (UTC date is Mar 1)
    const now = new Date("2026-03-01T19:30:00Z");
    const r = tzu.resolveDateRange({ timeZone: "Asia/Kolkata", now });
    assert.equal(iso(r.toDate), "2026-03-02T18:29:59.999Z");
    assert.equal(iso(r.fromDate), "2026-01-31T18:30:00.000Z"); // 30 local days: Jan 31 .. Mar 2
    const seven = tzu.resolveDateRange({ timeZone: "UTC", now: new Date("2026-03-10T12:00:00Z"), defaultDays: 7 });
    assert.equal(iso(seven.fromDate), "2026-03-04T00:00:00.000Z");
    assert.equal(iso(seven.toDate), "2026-03-10T23:59:59.999Z");
});

test("resolveDateRange: invalid input -> RangeInputError (400)", () => {
    const bad = [
        { from: "nope", timeZone: "UTC" },
        { to: "2026-99-99", timeZone: "UTC" },
        { from: "2026-03-05", to: "2026-03-01", timeZone: "UTC" },
        { timeZone: "Mars/Base" },
    ];
    for (const input of bad) {
        assert.throws(() => tzu.resolveDateRange(input), (e) => e instanceof tzu.RangeInputError && e.statusCode === 400, JSON.stringify(input));
    }
});

// ── the real report handlers ─────────────────────────────────────────────────

const fake = createFakeDb();
mock.module("../src/prisma/db.js", { namedExports: { db: fake.db }, defaultExport: fake.db });
const reports = await import("../controllers/reportsController.js");

const seedWorkspace = (timezone) => {
    fake.tables.Workspace = [{ id: "ws1", timezone }];
    fake.tables.Order = [];
};
const order = (at, net = 1000n, isNew = false) =>
    fake.tables.Order.push({ id: `o${fake.tables.Order.length}`, workspaceId: "ws1", status: "paid", orderedAt: at, netMinorUnits: net, isNewCustomer: isNew });
const reqFor = (query) => ({ query, workspaceId: "ws1", user: { role: "company_admin", workspaceId: "ws1" } });

test("parseReportParams defaults to the WORKSPACE timezone (not UTC) and honours ?tz override", async () => {
    seedWorkspace("Asia/Kolkata");
    const a = await reports.parseReportParams({ query: { from: "2026-03-02", to: "2026-03-02" } }, "ws1");
    assert.equal(a.tz, "Asia/Kolkata");
    assert.equal(iso(a.fromDate), "2026-03-01T18:30:00.000Z");
    const b = await reports.parseReportParams({ query: { from: "2026-03-02", to: "2026-03-02", tz: "UTC" } }, "ws1");
    assert.equal(iso(b.fromDate), "2026-03-02T00:00:00.000Z");
});

test("trend report (Kolkata): an order at 23:59:59 local belongs to that day, 00:00:00 local to the next — and range filters agree", async () => {
    seedWorkspace("Asia/Kolkata");
    order("2026-03-01T18:29:59.000Z", 1000n); // Mar 1 23:59:59 IST
    order("2026-03-01T18:30:00.000Z", 2000n); // Mar 2 00:00:00 IST
    order("2026-03-02T18:29:59.000Z", 4000n); // Mar 2 23:59:59 IST
    order("2026-03-02T18:30:00.000Z", 8000n); // Mar 3 00:00:00 IST

    const res = makeRes();
    await reports.getTrendReport(reqFor({ from: "2026-03-01", to: "2026-03-03" }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.tz, "Asia/Kolkata");
    assert.deepEqual(res.body.data.map((d) => [d.date, d.orders, d.netMinorUnits]),
        [["2026-03-01", 1, "1000"], ["2026-03-02", 2, "6000"], ["2026-03-03", 1, "8000"]]);

    // "just Mar 2" must contain exactly the two orders the trend assigns to Mar 2
    const one = makeRes();
    await reports.getTrendReport(reqFor({ from: "2026-03-02", to: "2026-03-02" }), one);
    assert.deepEqual(one.body.data.map((d) => [d.date, d.orders]), [["2026-03-02", 2]]);
});

test("trend report across a DST change (New York, 2026-03-08, a 23-hour day)", async () => {
    seedWorkspace("America/New_York");
    order("2026-03-08T04:59:59.000Z"); // Mar 7 23:59:59 EST
    order("2026-03-08T05:00:00.000Z"); // Mar 8 00:00:00 EST  (first moment of the short day)
    order("2026-03-09T03:59:59.000Z"); // Mar 8 23:59:59 EDT  (last moment of the short day)
    order("2026-03-09T04:00:00.000Z"); // Mar 9 00:00:00 EDT
    const res = makeRes();
    await reports.getTrendReport(reqFor({ from: "2026-03-07", to: "2026-03-09" }), res);
    assert.deepEqual(res.body.data.map((d) => [d.date, d.orders]), [["2026-03-07", 1], ["2026-03-08", 2], ["2026-03-09", 1]]);
});

test("report handlers answer 400 (not 500) for bad dates / timezone", async () => {
    seedWorkspace("UTC");
    for (const q of [{ from: "garbage" }, { tz: "Mars/Base" }, { from: "2026-03-05", to: "2026-03-01" }]) {
        const res = makeRes();
        await reports.getTrendReport(reqFor(q), res);
        assert.equal(res.statusCode, 400, JSON.stringify(q));
        assert.ok(res.body.message);
    }
});
