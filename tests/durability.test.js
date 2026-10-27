// Durable background jobs and shared rollup freshness (scope 4.12): what a restart or a second API
// instance must never break.
import "./setup.js";
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, makeRes } from "./fakeDb.js";

const fake = createFakeDb();
mock.module("../src/prisma/db.js", { namedExports: { db: fake.db }, defaultExport: fake.db });

const jobs = await import("../services/jobs.js");
const { ingestOrder } = await import("../services/ingestion.js");
const reports = await import("../controllers/reportsController.js");
const rollups = await import("../services/rollups.js");
const refunds = await import("../controllers/refundController.js");
const { scheduleRebuildIfNeeded } = await import("../services/workspaceSettings.js");

const T = fake.tables;
const WS = "ws1";
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

beforeEach(async () => {
    await jobs.drainJobs();
    jobs.setJobsPaused(false);
    for (const k of Object.keys(T)) T[k] = [];
    T.Workspace = [{ id: WS, timezone: "Asia/Kolkata", reportingCurrency: "INR", defaultModel: "last_non_direct", lookbackDays: 30, status: "active" }];
});

const report = async (handler, query) => {
    const res = makeRes();
    await handler({ query, workspaceId: WS, user: { role: "company_admin", workspaceId: WS } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
};

// ── durable jobs ─────────────────────────────────────────────────────────────

test("a durable job is stored before it runs and marked done after", async () => {
    let ran = 0;
    jobs.registerJobHandler("adspend.sync", async () => {
        ran++;
        return "ok";
    });
    assert.equal(await jobs.enqueueJob("adspend.sync", { workspaceId: WS, accountId: "a1" }), "ok");
    assert.equal(ran, 1);
    assert.equal(T.BackgroundJob.length, 1);
    assert.equal(T.BackgroundJob[0].status, "done");
    assert.equal(T.BackgroundJob[0].type, "adspend.sync");
    assert.ok(T.BackgroundJob[0].finishedAt);
});

test("changing reporting currency queues an immediate FX sync", async () => {
    jobs.setJobsPaused(true);
    await scheduleRebuildIfNeeded(WS, ["reportingCurrency"]);
    await jobs.drainJobs();

    const fxSync = T.BackgroundJob.find((job) => job.type === "fxrates.sync");
    assert.ok(fxSync);
    assert.equal(fxSync.status, "queued");
    assert.equal(fxSync.payload.day, new Date().toISOString().slice(0, 10));
    jobs.setJobsPaused(false);
});

test("non-durable jobs (inbound events, webhook deliveries) are not stored twice", async () => {
    jobs.registerJobHandler("test.memory", async () => 1);
    await jobs.enqueueJob("test.memory", { workspaceId: WS });
    assert.equal(T.BackgroundJob.length, 0);
});

test("a failed job is retried later with backoff, then stops as dead", async () => {
    jobs.registerJobHandler("attribution.rerun", async () => {
        throw new Error("boom");
    });
    await assert.rejects(jobs.enqueueJob("attribution.rerun", { workspaceId: WS }), /boom/);
    const row = T.BackgroundJob[0];
    assert.equal(row.status, "queued");
    assert.equal(row.attempts, 1);
    assert.ok(new Date(row.nextAttemptAt) > new Date(), "retry is in the future");
    assert.equal(row.lockedBy, null);
    // not yet due: nothing is resumed
    assert.equal((await jobs.resumeJobs()).resumed, 0);
    // due, last attempt allowed: it runs and becomes dead
    row.nextAttemptAt = iso(1000);
    row.attempts = jobs.MAX_JOB_ATTEMPTS - 1;
    assert.equal((await jobs.resumeJobs()).resumed, 1);
    await jobs.drainJobs();
    assert.equal(T.BackgroundJob[0].status, "dead");
    assert.match(T.BackgroundJob[0].lastError, /boom/);
    // a platform admin can queue it again
    assert.ok(await jobs.retryDeadJob(row.id));
    assert.equal(T.BackgroundJob[0].status, "queued");
    assert.equal(T.BackgroundJob[0].attempts, 0);
});

test("a job left 'running' by a stopped instance is resumed once its lock is stale, by one instance only", async () => {
    let ran = 0;
    jobs.registerJobHandler("rollups.rebuild", async () => {
        ran++;
    });
    T.BackgroundJob = [
        // the old process died mid-run 10 minutes ago
        { id: "j-stale", workspaceId: WS, type: "rollups.rebuild", payload: { workspaceId: WS }, dedupeKey: "k1", status: "running", attempts: 0, lockedBy: "dead-instance", lockedAt: iso(10 * 60_000), createdAt: iso(11 * 60_000) },
        // another live instance is working on this one right now: hands off
        { id: "j-live", workspaceId: "ws2", type: "rollups.rebuild", payload: { workspaceId: "ws2" }, dedupeKey: "k2", status: "running", attempts: 0, lockedBy: "other-instance", lockedAt: iso(20_000), createdAt: iso(60_000) },
    ];
    assert.equal((await jobs.resumeJobs()).resumed, 1);
    await jobs.drainJobs();
    assert.equal(ran, 1);
    const stale = T.BackgroundJob.find((j) => j.id === "j-stale");
    assert.equal(stale.status, "done");
    assert.equal(stale.attempts, 1, "the interrupted run counts as an attempt");
    assert.equal(T.BackgroundJob.find((j) => j.id === "j-live").status, "running");
    // nothing left to resume: a second pass (or a second instance) does nothing
    assert.equal((await jobs.resumeJobs()).resumed, 0);
});

test("the heartbeat keeps this instance's locks fresh, so other instances do not take its jobs", async () => {
    let release;
    jobs.registerJobHandler("attribution.rerun", () => new Promise((r) => (release = r)));
    const p = jobs.enqueueJob("attribution.rerun", { workspaceId: WS, from: "x" });
    await new Promise((r) => setTimeout(r, 10));
    const row = T.BackgroundJob[0];
    assert.equal(row.status, "running");
    assert.equal(row.lockedBy, jobs.INSTANCE_ID);
    row.lockedAt = iso(4 * 60_000);
    assert.equal(await jobs.heartbeat(), 1);
    assert.ok(Date.now() - new Date(row.lockedAt).getTime() < 5_000);
    assert.equal((await jobs.resumeJobs()).resumed, 0, "a held job is never resumed elsewhere");
    release();
    await p;
    assert.equal(T.BackgroundJob[0].status, "done");
});

// ── shared rollup freshness ──────────────────────────────────────────────────

test("rollup freshness is stored in the database, so a write on another instance makes reports live", async () => {
    await ingestOrder(WS, { externalId: "d1", orderedAt: "2026-03-02T10:00:00Z", currency: "INR", grossAmount: 100 });
    await jobs.drainJobs();
    const q = { from: "2026-03-01", to: "2026-03-31" };
    assert.equal((await report(reports.getChannelsReport, q)).source, "rollups", "the flush job built them");
    const ws = T.Workspace[0];
    assert.equal(ws.rollupsDataToken, ws.rollupsBuiltToken);
    assert.equal(T.RollupDirtyDay.length, 0);

    // another instance committed a write: it changed the token in the database (this process never saw it)
    ws.rollupsDataToken = "written-elsewhere";
    assert.equal((await report(reports.getChannelsReport, q)).source, "live");
    // ... and its dirty day alone is also enough to stop rollup reads for that range
    ws.rollupsDataToken = ws.rollupsBuiltToken;
    T.RollupDirtyDay.push({ id: "dd1", workspaceId: WS, day: "2026-03-05", createdAt: iso(0) });
    assert.equal((await report(reports.getChannelsReport, q)).source, "live");
    assert.equal((await report(reports.getChannelsReport, { from: "2026-04-01", to: "2026-04-30" })).source, "rollups", "other ranges stay fast");

    // the refresh (on any instance) folds it in
    await rollups.flushDirtyDays(WS);
    assert.equal(T.RollupDirtyDay.length, 0);
    assert.equal((await report(reports.getChannelsReport, q)).source, "rollups");
});

test("a write is visible as stale before the API answers; settings changes and re-runs invalidate too", async () => {
    await ingestOrder(WS, { externalId: "d2", orderedAt: "2026-03-02T10:00:00Z", currency: "INR", grossAmount: 100 });
    await jobs.drainJobs();
    jobs.setJobsPaused(true); // no refresh may run: freshness must already be off when ingest returns
    await ingestOrder(WS, { externalId: "d3", orderedAt: "2026-03-03T10:00:00Z", currency: "INR", grossAmount: 50 });
    const ws = T.Workspace[0];
    assert.notEqual(ws.rollupsDataToken, ws.rollupsBuiltToken);
    assert.ok(T.RollupDirtyDay.some((d) => d.day === "2026-03-03"));
    const live = await report(reports.getSummaryReport, { from: "2026-03-01", to: "2026-03-31" });
    assert.equal(live.revenue.netMinorUnits, "15000", "the new order is counted (live path)");
    jobs.setJobsPaused(false);

    // a stored flush was left queued by the paused run: the sweep / resume picks it up
    assert.deepEqual(await rollups.staleWorkspaceIds(), [WS]);
    await rollups.flushDirtyDays(WS);
    assert.deepEqual(await rollups.staleWorkspaceIds(), []);

    await rollups.invalidateRollups(WS);
    assert.deepEqual(await rollups.staleWorkspaceIds(), [WS]);
    // tokens differ without dirty days (settings change): the flush rebuilds everything
    await rollups.flushDirtyDays(WS);
    assert.deepEqual(await rollups.staleWorkspaceIds(), []);
    assert.equal((await report(reports.getSummaryReport, { from: "2026-03-01", to: "2026-03-31" })).revenue.netMinorUnits, "15000");
});

test("refunds list is company-scoped and paginated", async () => {
    await ingestOrder(WS, { externalId: "r1", orderedAt: "2026-03-02T10:00:00Z", currency: "INR", grossAmount: 100 });
    const { ingestRefund } = await import("../services/ingestion.js");
    for (let i = 0; i < 3; i++) await ingestRefund(WS, { externalOrderId: "r1", amount: 10, currency: "INR", refundedAt: `2026-03-1${i}T10:00:00Z`, externalId: `rf-${i}` });
    const page1 = await report(refunds.listRefunds, { limit: "2" });
    assert.equal(page1.data.length, 2);
    assert.equal(page1.pagination.total, 3);
    assert.equal(page1.totals.amountMinorUnits, "3000");
    assert.equal(page1.data[0].externalId, "rf-2", "newest first");
    const found = await report(refunds.listRefunds, { search: "rf-1" });
    assert.equal(found.data.length, 1);
});
