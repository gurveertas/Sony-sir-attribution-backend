/**
 * Metric rollups (store D8, scope 4.7): precomputed daily totals by company/location local day,
 * channel, campaign, model and new-vs-returning, in the reporting currency.
 *
 *   - Built from exactly the same facts as the live reports (services/metrics.js), so a report served
 *     from rollups equals the same report computed live, and the drill-down list adds up to it.
 *   - Refreshed for the affected days after every order / refund / booking (deduplicated job).
 *   - Freshness is stored in the database (tokens + RollupDirtyDay), so it is shared by every instance.
 *   - Rebuilt completely when timezone, currency or model settings change, and on demand.
 *   - Reports use rollups only when every requested day is fresh; otherwise they compute live.
 */

import crypto from "node:crypto";
import { db } from "../src/prisma/db.js";
import { tenantDb } from "./tenantDb.js";
import { enqueueJob, registerJobHandler } from "./jobs.js";
import { loadFacts, creditLines, shiftDay } from "./metrics.js";
import { ATTRIBUTION_MODELS } from "./attributionEngine.js";
import { localDateString, localMidnightUtc } from "../utils/timezone.js";

// Freshness lives in the database, so every API instance agrees (scope 4.12):
//   Workspace.rollupsDataToken   a new random token on every conversion write (and on invalidation)
//   Workspace.rollupsBuiltToken  the data token the last refresh had read before it started
//   RollupDirtyDay               local days still waiting for a refresh (insert-only from writers)
// Rollups are served only when the two tokens are equal and no dirty day falls in the range.
// Writers insert the dirty days FIRST and change the token AFTER, so a refresh that read a token has
// also seen that write's days. A refresh that loses a race leaves the tokens unequal (= live reports),
// never a stale read; the worker sweep repairs it.
const useRollups = () => String(process.env.USE_ROLLUPS_FOR_REPORTS ?? "true").toLowerCase() !== "false";
const newToken = () => crypto.randomUUID();

const hasRollupStore = (client = db) => {
    try {
        return typeof client.orm.public.DailyRollup?.where === "function" && typeof client.orm.public.DailyAttributionRollup?.where === "function";
    } catch {
        return false;
    }
};
const hasDirtyStore = (client = db) => {
    try {
        return typeof client.orm.public.RollupDirtyDay?.where === "function";
    } catch {
        return false;
    }
};

export const rollupsAvailable = () => hasRollupStore() && hasDirtyStore();

/** Mark the company's rollups out of date without saying which days (settings change, re-run). */
export async function invalidateRollups(workspaceId, client = db) {
    try {
        await client.orm.public.Workspace.where({ id: workspaceId }).update({ rollupsDataToken: newToken() });
    } catch (err) {
        // the column is missing only before the migration; then rollups are not available either
        console.error("[rollups] invalidate failed:", err?.message ?? err);
    }
}

/**
 * Called right after a conversion write commits (awaited, so the response is only sent once every
 * instance would see the rollups as stale). Records the local days the write touched.
 */
export async function noteWrite(workspaceId, instants = [], client = db) {
    if (!rollupsAvailable()) return;
    try {
        const workspace = await client.orm.public.Workspace.where({ id: workspaceId }).first();
        if (!workspace) return;
        const zones = new Set([workspace.timezone || "UTC"]);
        for (const l of await client.orm.public.Location.where({ workspaceId }).all()) if (l.timezone) zones.add(l.timezone);
        const days = new Set();
        for (const i of instants) for (const z of zones) days.add(localDateString(new Date(i), z));
        for (const day of days) await client.orm.public.RollupDirtyDay.create({ workspaceId, day });
    } catch (err) {
        console.error("[rollups] could not record dirty days:", err?.message ?? err);
    }
    await invalidateRollups(workspaceId, client);
    enqueueJob("rollups.flush", { workspaceId });
}

/** Back-compat name used by the refresh job of older queued payloads. */
export const markDirty = (workspaceId, instants = []) => noteWrite(workspaceId, instants);

export async function isFresh(workspace, fromDay, toDay, client = db) {
    if (!useRollups() || !rollupsAvailable() || !workspace?.rollupsBuiltAt) return false;
    if (!workspace.rollupsBuiltToken || workspace.rollupsBuiltToken !== workspace.rollupsDataToken) return false;
    try {
        const dirty = await tenantDb(client, workspace.id).RollupDirtyDay.where((d) => d.day.gte(fromDay)).where((d) => d.day.lte(toDay)).first();
        return !dirty;
    } catch {
        return false;
    }
}

const parseDay = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return { y, m, d };
};

function paramsFor(workspace, fromDay, toDay) {
    const tz = workspace.timezone || "UTC";
    return {
        workspace,
        tz,
        model: workspace.defaultModel || "last_non_direct",
        currency: workspace.reportingCurrency || "USD",
        range: {
            dayAligned: true,
            fromDay,
            toDay,
            fromDate: new Date(localMidnightUtc(parseDay(fromDay), tz)),
            toDate: new Date(localMidnightUtc(parseDay(shiftDay(toDay, 1)), tz) - 1),
        },
        locationId: null,
        includeTest: false,
        refundsBy: "refund_date",
        fxMode: workspace.fxRateMode || "transaction_date",
    };
}

/** Recompute the rollup rows of [fromDay, toDay] (inclusive). */
export async function rebuildDays(workspaceId, fromDay, toDay, client = db) {
    if (!hasRollupStore(client)) return { skipped: "rollup tables not migrated" };
    const workspace = await client.orm.public.Workspace.where({ id: workspaceId }).first();
    if (!workspace) return { skipped: "workspace not found" };
    const params = paramsFor(workspace, fromDay, toDay);
    const facts = await loadFacts(workspaceId, params, { models: ATTRIBUTION_MODELS, client });
    const currency = params.currency;

    const daily = new Map();
    const row = (day, locationId, isNew) => {
        const k = `${day}|${locationId ?? ""}|${isNew}`;
        if (!daily.has(k)) daily.set(k, { day, locationId, isNewCustomer: isNew, orders: 0, grossMinorUnits: 0n, discountMinorUnits: 0n, taxMinorUnits: 0n, refundMinorUnits: 0n, matchedNetMinorUnits: 0n, bookingsCreated: 0, bookedValueMinorUnits: 0n, currency });
        return daily.get(k);
    };
    for (const o of facts.orders) {
        const r = row(o.day, o.locationId, o.isNew);
        r.orders++;
        r.grossMinorUnits += o.gross;
        r.discountMinorUnits += o.discount;
        r.taxMinorUnits += o.tax;
        if (o.matchMethod !== "none") r.matchedNetMinorUnits += o.net;
    }
    for (const rf of facts.refunds) row(rf.day, rf.locationId, rf.isNew).refundMinorUnits += rf.amount;
    for (const b of facts.bookings) {
        if (!b.inPeriod) continue;
        const r = row(b.day, b.locationId, Boolean(b.raw.customerId && b.raw.isNewCustomer));
        r.bookingsCreated++;
        if (["scheduled", "confirmed", "rescheduled"].includes(b.raw.status)) r.bookedValueMinorUnits += b.value;
    }

    const attr = new Map();
    for (const model of ATTRIBUTION_MODELS) {
        for (const l of creditLines(facts, model)) {
            const k = `${l.day}|${l.locationId ?? ""}|${model}|${l.channel}|${l.campaign}|${l.isNew}`;
            const e = attr.get(k) ?? { day: l.day, locationId: l.locationId, model, channel: l.channel, campaign: l.campaign, isNewCustomer: l.isNew, creditedOrders: 0, attributedMinorUnits: 0n, refundMinorUnits: 0n, currency };
            if (l.kind === "sale") e.creditedOrders += l.share;
            else e.refundMinorUnits += -l.amount;
            e.attributedMinorUnits += l.amount;
            attr.set(k, e);
        }
    }

    await client.transaction(async (tx) => {
        const tt = tenantDb(tx, workspaceId);
        await tt.DailyRollup.where((x) => x.day.gte(fromDay)).where((x) => x.day.lte(toDay)).delete();
        await tt.DailyAttributionRollup.where((x) => x.day.gte(fromDay)).where((x) => x.day.lte(toDay)).delete();
        for (const r of daily.values()) await tt.DailyRollup.create(r);
        for (const r of attr.values()) await tt.DailyAttributionRollup.create({ ...r, creditedOrders: Math.round(r.creditedOrders * 1e6) / 1e6 });
    });
    return { days: [fromDay, toDay], dailyRows: daily.size, attributionRows: attr.size };
}

/** Full rebuild from the first recorded day to today. */
export async function rebuildAll(workspaceId, client = db) {
    if (!hasRollupStore(client)) return { skipped: "rollup tables not migrated" };
    const t = tenantDb(client, workspaceId);
    const workspace = await client.orm.public.Workspace.where({ id: workspaceId }).first();
    if (!workspace) return { skipped: "workspace not found" };
    const tz = workspace.timezone || "UTC";
    const instants = [
        ...(await t.Order.all()).map((o) => o.orderedAt),
        ...(await t.Refund.all()).map((r) => r.refundedAt),
        ...(await t.Booking.all()).map((b) => b.bookedAt ?? b.createdAt),
    ].filter(Boolean);
    const today = localDateString(new Date(), tz);
    const first = instants.length ? shiftDay(instants.map((i) => localDateString(new Date(i), tz)).sort()[0], -1) : today;
    const snapshot = workspace.rollupsDataToken ?? null;
    const folded = hasDirtyStore(client) ? await t.RollupDirtyDay.all() : [];
    // drop rows outside the data range (e.g. after a timezone change shifted every day)
    await client.transaction(async (tx) => {
        const tt = tenantDb(tx, workspaceId);
        await tt.DailyRollup.where({ workspaceId }).delete();
        await tt.DailyAttributionRollup.where({ workspaceId }).delete();
    });
    const out = await rebuildDays(workspaceId, first, shiftDay(today, 1), client);
    for (const d of folded) await t.RollupDirtyDay.where({ id: d.id }).delete();
    const token = snapshot ?? newToken();
    // a rebuild of a company that never had a token gives it one, so the two can match
    await client.orm.public.Workspace.where({ id: workspaceId }).update({ rollupsBuiltAt: new Date().toISOString(), rollupsBuiltToken: token, ...(snapshot ? {} : { rollupsDataToken: token }) });
    return out;
}

/** Fold the dirty days into the rollups (the refresh job). */
export async function flushDirtyDays(workspaceId, client = db) {
    if (!rollupsAvailable()) return null;
    const workspace = await client.orm.public.Workspace.where({ id: workspaceId }).first();
    if (!workspace) return null;
    if (!workspace.rollupsBuiltAt) return rebuildAll(workspaceId, client);
    const snapshot = workspace.rollupsDataToken ?? null;
    const t = tenantDb(client, workspaceId);
    const rows = await t.RollupDirtyDay.all();
    if (!rows.length) {
        if (snapshot && snapshot === workspace.rollupsBuiltToken) return null;
        // tokens differ without dirty days: a settings change or an invalidation -> rebuild everything
        return rebuildAll(workspaceId, client);
    }
    const days = [...new Set(rows.map((r) => r.day))].sort();
    const out = await rebuildDays(workspaceId, days[0], days[days.length - 1], client);
    for (const r of rows) await t.RollupDirtyDay.where({ id: r.id }).delete();
    await client.orm.public.Workspace.where({ id: workspaceId }).update({ rollupsBuiltToken: snapshot });
    return out;
}

/** Rebuild after something changed the meaning of past days (settings, merges, re-runs, FX). */
export async function requestRebuild(workspaceId, reason = null) {
    await invalidateRollups(workspaceId);
    enqueueJob("rollups.rebuild", { workspaceId, ...(reason ? { reason } : {}) });
}

/** Companies whose rollups are behind and have no refresh running (worker sweep). */
export async function staleWorkspaceIds(client = db) {
    if (!rollupsAvailable()) return [];
    const rows = await client.orm.public.Workspace.where({ status: "active" }).all();
    return rows.filter((w) => w.rollupsBuiltAt && w.rollupsDataToken !== w.rollupsBuiltToken).map((w) => w.id);
}

registerJobHandler("rollups.refresh", ({ workspaceId, instants }) => noteWrite(workspaceId, instants ?? []));
registerJobHandler("rollups.flush", ({ workspaceId }) => flushDirtyDays(workspaceId));
registerJobHandler("rollups.rebuild", ({ workspaceId }) => rebuildAll(workspaceId));

// ── Reading ─────────────────────────────────────────────────────────────────

/** Rollup rows for a fresh, day-aligned range (null when the live path must be used). */
export async function readRollups(params, { locationId = null } = {}) {
    const { workspace, range } = params;
    if ((params.locationIds?.length ?? 0) > 1) return null;
    if (!range.dayAligned || params.includeTest || params.refundsBy !== "refund_date" || params.currency !== (workspace.reportingCurrency || "USD")) return null;
    // rollups hold amounts converted with the company's FX mode; another mode is computed live
    if ((params.fxMode ?? "transaction_date") !== (workspace.fxRateMode || "transaction_date")) return null;
    if (!(await isFresh(workspace, range.fromDay, range.toDay))) return null;
    const t = tenantDb(db, workspace.id);
    let daily = await t.DailyRollup.where((x) => x.day.gte(range.fromDay)).where((x) => x.day.lte(range.toDay)).all();
    let attribution = (await t.DailyAttributionRollup.where({ model: params.model }).all()).filter((x) => x.day >= range.fromDay && x.day <= range.toDay);
    if (locationId) {
        daily = daily.filter((r) => r.locationId === locationId);
        attribution = attribution.filter((r) => r.locationId === locationId);
    }
    return { daily, attribution, builtAt: workspace.rollupsBuiltAt };
}
