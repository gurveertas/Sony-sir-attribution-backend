/**
 * Background workers, started once by server.js (disable with DISABLE_BACKGROUND_WORKERS=true, e.g.
 * on extra API-only instances). Every task re-reads durable state from the database, so a restart
 * or a second instance never loses work; idempotent processing makes double runs harmless.
 *
 *   every 15 s  queue due inbound events (pending after a restart, failed after their backoff)
 *   every 1 min keep this instance's job locks fresh; resume stored jobs a stopped instance left
 *               behind (or that wait for a retry)
 *   every 30 s  queue due outbound webhook deliveries
 *   every 10 min rebuild rollups that were never built for a company with data, and refresh rollups
 *               that are behind
 *   every hour  sync ad spend for connected Meta / Google accounts (each account at most every 6 h)
 *   every day   sync ECB reference FX rates, backfill missing order snapshots, and rebuild rollups
 *   every day   apply data retention
 */

import { db } from "../src/prisma/db.js";
import { enqueueJob, registerJobHandler, drainJobs, resumeJobs, heartbeat, purgeFinishedJobs } from "./jobs.js";
import { pollDueEvents } from "./eventQueue.js";
import { pollDueDeliveries } from "./webhookDispatcher.js";
import { rollupsAvailable, requestRebuild, staleWorkspaceIds } from "./rollups.js";
import { reattributeWorkspace } from "./ingestion.js";
import { applyRetention } from "./privacy.js";
import { syncAccount, platformConfigured } from "./adPlatforms.js";
import { writeAudit } from "./audit.js";
import ENV from "../utils/env.js";
import { findRate, syncLatestRates } from "./fx.js";
import "./rollups.js"; // registers the rollup job handlers

const timers = [];
const every = (ms, fn, label) => {
    const run = () =>
        Promise.resolve()
            .then(fn)
            .catch((err) => console.error(`[worker] ${label}:`, err?.message ?? err));
    timers.push(setInterval(run, ms));
    timers[timers.length - 1].unref?.();
    return run;
};

registerJobHandler("attribution.rerun", async ({ workspaceId, from = null, to = null, actorUserId = null, reason = null }) => {
    const out = await reattributeWorkspace(workspaceId, { from, to });
    await requestRebuild(workspaceId); // never await a job of the same company lane from inside one
    await writeAudit(db.orm.public, {
        workspaceId,
        actorType: actorUserId ? "user" : "system",
        actorUserId,
        action: "attribution.rerun_completed",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: { ...out, from, to, reason },
    });
    return out;
});

registerJobHandler("adspend.sync", ({ workspaceId, accountId }) => syncAccount(workspaceId, accountId));

registerJobHandler("fxrates.sync", async () => {
    const result = await syncLatestRates(db.orm.public);
    const backfillFrom = `${result.startDate}T00:00:00.000Z`;
    const candidates = (
        await db.orm.public.Order
            .where((o) => o.fxRateToReporting.isNull())
            .where((o) => o.orderedAt.gte(backfillFrom))
            .all()
    );
    const supportedCurrencies = new Set(result.currencies);
    const touched = new Set();
    let backfilled = 0;
    for (const order of candidates) {
        if (backfilled >= 20_000) break;
        if (
            !order.reportingCurrency ||
            order.currency === order.reportingCurrency ||
            !supportedCurrencies.has(order.currency) ||
            !supportedCurrencies.has(order.reportingCurrency)
        ) continue;
        const rate = await findRate(db.orm.public, String(order.orderedAt).slice(0, 10), order.currency, order.reportingCurrency);
        if (rate === null) continue;
        await db.orm.public.Order.where({ id: order.id }).update({ fxRateToReporting: rate });
        backfilled++;
        touched.add(order.workspaceId);
    }
    for (const workspaceId of touched) await requestRebuild(workspaceId, "fx_rates");
    console.info("[fx] daily rates synced", { ...result, backfilled });
    return { ...result, backfilled };
});

function fxRateSweep() {
    if (!ENV.FX_AUTO_SYNC_ENABLED) return;
    const day = new Date().toISOString().slice(0, 10);
    enqueueJob("fxrates.sync", { day });
}

async function rollupSweep() {
    if (!rollupsAvailable()) return;
    for (const w of await db.orm.public.Workspace.where({ status: "active" }).all()) {
        if (w.rollupsBuiltAt) continue;
        const anyOrder = await db.orm.public.Order.where({ workspaceId: w.id }).first();
        if (anyOrder) await requestRebuild(w.id);
    }
    // rollups left behind (a refresh lost a race, or failed): fold the dirty days in again
    for (const id of await staleWorkspaceIds()) enqueueJob("rollups.flush", { workspaceId: id });
}

async function adSpendSweep() {
    if (!platformConfigured("meta") && !platformConfigured("google")) return;
    let accounts = [];
    try {
        accounts = await db.orm.public.AdAccount.where((a) => a.status.in(["healthy", "failing", "pending"])).all();
    } catch {
        return; // table not migrated
    }
    const sixHours = 6 * 3600_000;
    for (const a of accounts) {
        if (!platformConfigured(a.platform)) continue;
        if (a.lastSyncedAt && Date.now() - new Date(a.lastSyncedAt).getTime() < sixHours) continue;
        enqueueJob("adspend.sync", { workspaceId: a.workspaceId, accountId: a.id });
    }
}

let started = false;
export function startWorkers() {
    if (started) return;
    started = true;
    every(15_000, () => pollDueEvents(), "event poll")();
    every(60_000, () => heartbeat(), "job heartbeat");
    every(60_000, () => resumeJobs(), "job resume")();
    every(30_000, () => pollDueDeliveries(), "webhook poll");
    every(10 * 60_000, rollupSweep, "rollup sweep")();
    every(60 * 60_000, adSpendSweep, "ad spend sweep");
    every(24 * 60 * 60_000, fxRateSweep, "FX rate sync")();
    fxRateSweep();
    every(24 * 60 * 60_000, async () => {
        await applyRetention();
        await purgeFinishedJobs(14);
    }, "retention");
    console.log("[worker] background workers started");
}

export async function stopWorkers() {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    started = false;
    await drainJobs();
}
