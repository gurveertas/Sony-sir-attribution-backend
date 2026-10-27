/**
 * Background jobs (rollup refreshes and rebuilds, attribution re-runs, ad spend syncs, connector event
 * processing, webhook deliveries).
 *
 * - `enqueueJob(type, payload)` never blocks the request that triggered it.
 * - Jobs with the same dedupe key (type + workspace + day/range) are merged while still waiting.
 * - Jobs run one at a time per workspace, so a re-run and a rebuild never interleave.
 * - Handlers register themselves with `registerJobHandler` (see services/workers.js).
 *
 * Durability (scope 4.12):
 * - Inbound events and outbound webhooks are durable through their own rows (RawEvent /
 *   WebhookDelivery, re-polled by services/workers.js); their jobs here only speed things up.
 * - Every other job type is stored in the BackgroundJob table before it runs. While this process
 *   holds it, it refreshes `lockedAt` every minute. If the process stops (restart, crash, deploy),
 *   the lock goes stale after LOCK_STALE_MS and any instance resumes the job (`resumeJobs`).
 *   Failed jobs retry with backoff, then stop as "dead" (visible in platform health).
 * - Without the table (not migrated yet) jobs still run, in memory only.
 */

import crypto from "node:crypto";
import { db } from "../src/prisma/db.js";

const handlers = new Map();
const pending = new Map(); // dedupeKey -> job
const queues = new Map(); // workspaceId -> Promise chain
const held = new Set(); // BackgroundJob ids this process is holding (queued here or running)
const stats = { enqueued: 0, completed: 0, failed: 0, running: 0, resumed: 0 };
let paused = false;

/** Job types that must survive a restart. */
export const DURABLE_JOB_TYPES = new Set(["attribution.rerun", "rollups.rebuild", "rollups.flush", "adspend.sync", "fxrates.sync"]);
export const INSTANCE_ID = crypto.randomUUID();
export const LOCK_STALE_MS = 5 * 60_000;
export const MAX_JOB_ATTEMPTS = 5;

export function registerJobHandler(type, fn) {
    handlers.set(type, fn);
}

const dedupeKeyOf = (type, p) => [type, p.workspaceId ?? "-", p.day ?? "", p.from ?? "", p.to ?? "", p.rawEventId ?? "", p.deliveryId ?? "", p.version ?? "", p.accountId ?? ""].join("|");

function store() {
    try {
        const m = db?.orm?.public?.BackgroundJob;
        return typeof m?.where === "function" && typeof m?.create === "function" ? m : null;
    } catch {
        return null;
    }
}
let storeBroken = false; // the model exists but the table does not (contract newer than the database)
const nowIso = () => new Date().toISOString();
const backoffMs = (attempts) => Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

async function persist(type, payload, key) {
    const s = !storeBroken && store();
    if (!s) return null;
    try {
        const row = await s.create({
            workspaceId: payload.workspaceId ?? null,
            type,
            payload: JSON.parse(JSON.stringify(payload)),
            dedupeKey: key,
            status: "queued",
            attempts: 0,
            lockedBy: INSTANCE_ID,
            lockedAt: nowIso(),
        });
        held.add(row.id);
        return row.id;
    } catch (err) {
        if (/does not exist|relation|undefined table/i.test(String(err?.message))) storeBroken = true;
        else console.error(`[jobs] could not store ${type}:`, err?.message ?? err);
        return null;
    }
}

async function mark(id, changes) {
    const s = store();
    if (!id || !s) return;
    try {
        await s.where({ id }).update(changes);
    } catch (err) {
        console.error("[jobs] could not update job row:", err?.message ?? err);
    }
}

/**
 * @param {string} type
 * @param {object} payload   JSON-serialisable
 * @param {{ jobId?: string, attempts?: number }} [opts]  used when resuming a stored job
 * @returns {Promise<any>} settles when the job ran (callers usually ignore it).
 */
export function enqueueJob(type, payload = {}, opts = {}) {
    const key = dedupeKeyOf(type, payload);
    const existing = pending.get(key);
    if (existing) {
        // a resumed copy of a job that is already waiting here: fold it in
        if (opts.jobId && opts.jobId !== existing.jobId) {
            held.add(opts.jobId);
            existing.alsoDone.push(opts.jobId);
        }
        return existing.promise;
    }

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    promise.catch(() => {}); // a failed job must never become an unhandled rejection
    const job = { type, payload, key, promise, jobId: opts.jobId ?? null, attempts: opts.attempts ?? 0, alsoDone: [] };
    pending.set(key, job);
    stats.enqueued++;
    if (job.jobId) held.add(job.jobId);
    const stored = job.jobId || !DURABLE_JOB_TYPES.has(type) ? Promise.resolve(job.jobId) : persist(type, payload, key);

    const lane = payload.workspaceId ?? "_global";
    const prev = queues.get(lane) ?? Promise.resolve();
    const next = Promise.all([prev.catch(() => {}), stored])
        .then(async ([, jobId]) => {
            job.jobId = jobId;
            pending.delete(key);
            const ids = [jobId, ...job.alsoDone].filter(Boolean);
            const release = () => ids.forEach((id) => held.delete(id));
            if (paused) {
                release(); // left "queued": another run (or resumeJobs) picks it up
                return resolve(undefined);
            }
            const handler = handlers.get(type);
            if (!handler) {
                release();
                resolve(undefined);
                return;
            }
            stats.running++;
            for (const id of ids) await mark(id, { status: "running", lockedBy: INSTANCE_ID, lockedAt: nowIso() });
            try {
                const out = await handler(payload);
                stats.completed++;
                for (const id of ids) await mark(id, { status: "done", finishedAt: nowIso(), lastError: null });
                resolve(out);
            } catch (err) {
                stats.failed++;
                const attempts = job.attempts + 1;
                const message = String(err?.message ?? err).slice(0, 1000);
                console.error(`[jobs] ${type} failed (attempt ${attempts}):`, message);
                const dead = attempts >= MAX_JOB_ATTEMPTS;
                for (const id of ids) {
                    await mark(id, dead
                        ? { status: "dead", attempts, lastError: message, finishedAt: nowIso(), lockedBy: null }
                        : { status: "queued", attempts, lastError: message, nextAttemptAt: new Date(Date.now() + backoffMs(attempts)).toISOString(), lockedBy: null, lockedAt: null });
                }
                reject(err);
            } finally {
                stats.running--;
                release();
            }
        });
    queues.set(lane, next);
    next.finally(() => {
        if (queues.get(lane) === next) queues.delete(lane);
    });
    return promise;
}

/** Keep the locks of the jobs this process holds fresh, so no other instance takes them over. */
export async function heartbeat() {
    const s = store();
    if (!s || storeBroken || !held.size) return 0;
    const at = nowIso();
    for (const id of held) {
        try {
            await s.where({ id, lockedBy: INSTANCE_ID }).update({ lockedAt: at });
        } catch {
            /* next beat */
        }
    }
    return held.size;
}

/**
 * Pick up stored jobs nobody is running: left over by a stopped instance, or waiting for their retry.
 * Safe with several instances: a job is claimed with a conditional update and re-read.
 */
export async function resumeJobs({ limit = 100 } = {}) {
    const s = store();
    if (!s || storeBroken) return { resumed: 0 };
    let rows;
    try {
        rows = await s.where((j) => j.status.in(["queued", "running"])).all();
    } catch (err) {
        if (/does not exist|relation|undefined table/i.test(String(err?.message))) storeBroken = true;
        return { resumed: 0 };
    }
    const now = Date.now();
    const stale = (r) => !r.lockedBy || !r.lockedAt || now - new Date(r.lockedAt).getTime() > LOCK_STALE_MS;
    const due = (r) => !r.nextAttemptAt || new Date(r.nextAttemptAt).getTime() <= now;
    const candidates = rows
        .filter((r) => !held.has(r.id) && stale(r) && (r.status === "running" || due(r)))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .slice(0, limit);

    let resumed = 0;
    for (const r of candidates) {
        const claimAt = nowIso();
        // a job that was "running" when its process died counts as one attempt
        const attempts = (r.attempts ?? 0) + (r.status === "running" ? 1 : 0);
        try {
            let claim = s.where({ id: r.id, status: r.status });
            claim = r.lockedAt ? claim.where({ lockedAt: r.lockedAt }) : claim.where((j) => j.lockedAt.isNull());
            await claim.update({ lockedBy: INSTANCE_ID, lockedAt: claimAt, status: "queued", attempts });
            const mine = await s.where({ id: r.id }).first();
            if (mine?.lockedBy !== INSTANCE_ID || mine?.lockedAt !== claimAt) continue; // another instance won
        } catch {
            continue;
        }
        if (!handlers.has(r.type)) {
            await mark(r.id, { status: "dead", lastError: `no handler for ${r.type}`, finishedAt: nowIso() });
            continue;
        }
        if (attempts >= MAX_JOB_ATTEMPTS) {
            await mark(r.id, { status: "dead", attempts, lastError: r.lastError ?? "stopped while running too many times", finishedAt: nowIso() });
            continue;
        }
        enqueueJob(r.type, r.payload ?? {}, { jobId: r.id, attempts });
        stats.resumed++;
        resumed++;
    }
    return { resumed };
}

/** Counts by status for platform health. */
export async function durableJobStats() {
    const s = store();
    if (!s || storeBroken) return { available: false };
    try {
        const rows = await s.where((j) => j.status.in(["queued", "running", "dead"])).all();
        const count = (st) => rows.filter((r) => r.status === st).length;
        const oldest = rows.filter((r) => r.status === "queued").map((r) => r.createdAt).sort()[0] ?? null;
        return {
            available: true,
            queued: count("queued"),
            running: count("running"),
            dead: count("dead"),
            oldestQueuedAt: oldest,
            recentDead: rows.filter((r) => r.status === "dead").sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt))).slice(0, 10).map((r) => ({ id: r.id, type: r.type, workspaceId: r.workspaceId, lastError: r.lastError, finishedAt: r.finishedAt })),
        };
    } catch {
        return { available: false };
    }
}

/** Retry a dead job (platform admin). */
export async function retryDeadJob(id) {
    const s = store();
    if (!s) return null;
    const row = await s.where({ id }).first();
    if (!row || row.status !== "dead") return null;
    await s.where({ id }).update({ status: "queued", attempts: 0, nextAttemptAt: null, lockedBy: null, lockedAt: null, finishedAt: null });
    return row;
}

/** Delete finished job rows older than `days` (retention). */
export async function purgeFinishedJobs(days = 14) {
    const s = store();
    if (!s || storeBroken) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    try {
        const old = (await s.where({ status: "done" }).all()).filter((r) => r.finishedAt && r.finishedAt < cutoff);
        for (const r of old) await s.where({ id: r.id }).delete();
        return old.length;
    } catch {
        return 0;
    }
}

export const jobStats = () => ({ ...stats, waiting: pending.size, held: held.size, instanceId: INSTANCE_ID });

/** Wait until every queued job has finished (tests, graceful shutdown). */
export async function drainJobs() {
    for (let i = 0; i < 100 && (queues.size || pending.size); i++) {
        await Promise.allSettled([...queues.values()]);
    }
}

/** Tests: stop running jobs (they are acknowledged and left queued). */
export function setJobsPaused(value) {
    paused = Boolean(value);
}
