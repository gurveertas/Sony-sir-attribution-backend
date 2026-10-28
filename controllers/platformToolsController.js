/**
 * Platform admin console tools (scope 4.9) — /api/platform-admin/*
 *
 *   GET    /health                                  events/min, queue depth, failed + dead events, slowest
 *                                                   connectors, errors by company, worker stats
 *   GET    /approvals                               companies waiting for approval
 *   POST   /workspaces                              create a company (+ first admin) on someone's behalf
 *   POST   /workspaces/:workspaceId/replay          replay raw events (from/to, status)  { reason }
 *   POST   /workspaces/:workspaceId/rerun-attribution { from?, to?, reason }
 *   POST   /workspaces/:workspaceId/rebuild-rollups
 *   POST   /api-keys/:keyId/rotate                  { reason, graceHours? }
 *   DELETE /workspaces/:workspaceId/data            { reason, confirm: <company slug>, keepAccount? }
 *   GET    /audit-log                               platform-wide admin actions
 *   GET|POST /fx-rates                              daily FX snapshots used for reporting currency
 *
 * Every tool requires a written reason and is written to the audit log the company can see.
 */

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db } from "../src/prisma/db.js";
import { tenantDb } from "../services/tenantDb.js";
import { writeAudit, getAuditStore } from "../services/audit.js";
import { enqueueJob, jobStats, durableJobStats, retryDeadJob } from "../services/jobs.js";
import { queueHealth, processRawEvent } from "../services/eventQueue.js";
import { purgeWorkspace } from "../services/privacy.js";
import { rotateKeyRecord } from "./apiKeyController.js";
import { upsertRates } from "../services/fx.js";
import { passwordProblem } from "../utils/passwordPolicy.js";
import { isValidTimeZone } from "../utils/timezone.js";
import genSlug from "../utils/genSlug.js";
import { sendError, paginate, sortDesc, wantsCsv, sendCsv } from "../services/http.js";
import { requestRebuild } from "../services/rollups.js";

const orm = () => db.orm.public;
const reasonOf = (req) => String(req.body?.reason ?? req.query?.reason ?? "").trim();
const needReason = (req, res) => {
    const r = reasonOf(req);
    if (r.length < 5) {
        res.status(400).json({ message: "Provide a reason of at least 5 characters.", code: "reason_required" });
        return null;
    }
    return r.slice(0, 500);
};
const audit = (req, action, extra) => writeAudit(orm(), { actorType: "platform_admin", actorUserId: req.user.id, action, ip: req.ip ?? null, userAgent: req.headers?.["user-agent"] ?? null, ...extra });

export const getPlatformHealth = async (req, res) => {
    try {
        const since = new Date(Date.now() - 24 * 3600_000).toISOString();
        const recent = await orm().RawEvent.where((e) => e.receivedAt.gte(since)).all();
        const lastHour = recent.filter((e) => Date.now() - new Date(e.receivedAt).getTime() <= 3600_000);
        const queue = await queueHealth();

        const latency = new Map();
        for (const e of recent) {
            if (!e.connectorId || !e.processedAt) continue;
            const ms = new Date(e.processedAt) - new Date(e.receivedAt);
            const l = latency.get(e.connectorId) ?? { connectorId: e.connectorId, workspaceId: e.workspaceId, events: 0, totalMs: 0, maxMs: 0 };
            l.events++;
            l.totalMs += ms;
            l.maxMs = Math.max(l.maxMs, ms);
            latency.set(e.connectorId, l);
        }
        const connectors = new Map((await orm().Connector.all()).map((c) => [c.id, c]));
        const slowest = [...latency.values()]
            .map((l) => ({ ...l, type: connectors.get(l.connectorId)?.type ?? null, name: connectors.get(l.connectorId)?.name ?? null, avgMs: Math.round(l.totalMs / l.events) }))
            .sort((a, b) => b.avgMs - a.avgMs)
            .slice(0, 10);

        const workspaces = new Map((await orm().Workspace.all()).map((w) => [w.id, w]));
        const errors = new Map();
        for (const e of recent.filter((x) => ["failed", "dead"].includes(x.status))) {
            const r = errors.get(e.workspaceId) ?? { workspaceId: e.workspaceId, name: workspaces.get(e.workspaceId)?.name ?? null, failed: 0, dead: 0, lastError: null };
            r[e.status]++;
            r.lastError = e.error ?? r.lastError;
            errors.set(e.workspaceId, r);
        }
        const within60s = recent.filter((e) => e.processedAt && new Date(e.processedAt) - new Date(e.receivedAt) <= 60_000).length;

        return res.status(200).json({
            eventsPerMinute: Math.round((lastHour.length / 60) * 100) / 100,
            eventsLast24h: recent.length,
            processedWithin60sPercent: recent.length ? Math.round((within60s / recent.length) * 1000) / 10 : null,
            queue,
            jobs: jobStats(),
            backgroundJobs: await durableJobStats(),
            slowestConnectors: slowest,
            failingConnectors: [...connectors.values()].filter((c) => c.status === "failing").map((c) => ({ id: c.id, workspaceId: c.workspaceId, type: c.type, name: c.name, errorCount: c.errorCount, lastError: c.lastError, lastErrorAt: c.lastErrorAt })),
            errorsByCompany: [...errors.values()].sort((a, b) => b.failed + b.dead - (a.failed + a.dead)),
            process: { uptimeSeconds: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576) },
            lastUpdated: new Date().toISOString(),
        });
    } catch (error) {
        return sendError(res, error, "platformHealth");
    }
};

/** Company list stats (4.9): events per day, last event time, integration health. */
export async function workspaceStats(workspaceIds) {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const raws = await orm().RawEvent.where((e) => e.receivedAt.gte(since)).all();
    const connectors = await orm().Connector.all();
    const out = new Map();
    for (const id of workspaceIds) {
        const ev = raws.filter((e) => e.workspaceId === id);
        const cs = connectors.filter((c) => c.workspaceId === id && c.status !== "disabled");
        const last = [...ev.map((e) => e.receivedAt), ...cs.map((c) => c.lastEventAt).filter(Boolean)].sort().at(-1) ?? null;
        out.set(id, {
            eventsPerDay: Math.round((ev.length / 7) * 10) / 10,
            lastEventAt: last,
            integrationHealth: cs.some((c) => c.status === "failing") ? "failing" : cs.length ? (cs.every((c) => c.status === "healthy") ? "healthy" : "pending") : "none",
            connectors: cs.length,
        });
    }
    return out;
}

export const listApprovals = async (req, res) => {
    try {
        const rows = await orm().Workspace.where({ status: "pending" }).all();
        sortDesc(rows, "createdAt");
        return res.status(200).json({ data: rows.map(({ emailVerificationHash, ...w }) => ({ ...w, emailVerified: !emailVerificationHash })) });
    } catch (error) {
        return sendError(res, error, "listApprovals");
    }
};

/** Body: { name, country, timezone?, currency?, websiteUrl?, industry?, admin: { name, email, password } } */
export const createWorkspaceForCompany = async (req, res) => {
    try {
        const b = req.body ?? {};
        const admin = b.admin ?? { name: b.adminName, email: b.email, password: b.password };
        if (!b.name || !String(b.name).trim()) return res.status(400).json({ message: "name is required", code: "validation_error" });
        if (!/^[A-Za-z]{2}$/.test(String(b.country ?? ""))) return res.status(400).json({ message: "country must be a 2-letter ISO code", code: "validation_error" });
        const tz = b.timezone || "UTC";
        if (!isValidTimeZone(tz)) return res.status(400).json({ message: "timezone must be an IANA name", code: "validation_error" });
        const email = String(admin?.email ?? "").trim().toLowerCase();
        if (!email.includes("@")) return res.status(400).json({ message: "admin.email is required", code: "validation_error" });
        const pw = passwordProblem(admin.password, email);
        if (pw) return res.status(400).json({ message: pw, code: "weak_password" });
        if (await orm().User.where({ email }).first()) return res.status(409).json({ message: "Email is already registered", code: "conflict" });

        const out = await db.transaction(async (tx) => {
            const workspace = await tx.orm.public.Workspace.create({
                name: String(b.name).trim(),
                slug: `${genSlug(b.name)}-${crypto.randomBytes(3).toString("hex")}`,
                country: b.country.toUpperCase(),
                timezone: tz,
                reportingCurrency: /^[A-Za-z]{3}$/.test(String(b.currency ?? "")) ? b.currency.toUpperCase() : "USD",
                websiteUrl: b.websiteUrl ?? null,
                industry: b.industry ?? null,
                status: "active",
                approvedAt: new Date().toISOString(),
                approvedBy: req.user.id,
            });
            const user = await tx.orm.public.User.create({
                workspaceId: workspace.id,
                email,
                name: String(admin.name || email).trim(),
                passwordHash: await bcrypt.hash(admin.password, 10),
                role: "company_admin",
                status: "active",
                emailVerifiedAt: new Date().toISOString(),
                passwordChangedAt: new Date().toISOString(),
            });
            await writeAudit(tx.orm.public, { workspaceId: workspace.id, actorType: "platform_admin", actorUserId: req.user.id, action: "admin.workspace_created", targetType: "workspace", targetId: workspace.id, ip: req.ip ?? null, userAgent: req.headers?.["user-agent"] ?? null });
            return { workspace, user };
        });
        return res.status(201).json({ data: { workspaceId: out.workspace.id, slug: out.workspace.slug, adminUserId: out.user.id } });
    } catch (error) {
        return sendError(res, error, "createWorkspace");
    }
};

/** Body: { reason, from?, to?, status? ("failed" | "dead" | "all") } — oldest first, so orders run before refunds. */
export const replayWorkspaceEvents = async (req, res) => {
    try {
        const reason = needReason(req, res);
        if (!reason) return;
        const workspaceId = req.params.workspaceId;
        const t = tenantDb(db, workspaceId);
        const { from = null, to = null, status = "failed" } = req.body ?? {};
        let rows = await t.RawEvent.all();
        if (from) rows = rows.filter((e) => new Date(e.receivedAt) >= new Date(from));
        if (to) rows = rows.filter((e) => new Date(e.receivedAt) <= new Date(to));
        if (status !== "all") rows = rows.filter((e) => e.status === status || (status === "failed" && e.status === "pending"));
        rows.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
        rows = rows.slice(0, 5000);
        const results = { attempted: 0, processed: 0, failed: 0, dead: 0 };
        for (const e of rows) {
            // a forced replay: reset the state, keep the history count
            await t.RawEvent.where({ id: e.id }).update({ status: "pending", attempts: 0, replayCount: (e.replayCount ?? 0) + 1, nextAttemptAt: null });
            const outcome = await processRawEvent(e.id);
            results.attempted++;
            if (outcome in results) results[outcome]++;
        }
        await audit(req, "admin.events_replayed", { workspaceId, targetType: "workspace", targetId: workspaceId, reason, metadata: { from, to, status, ...results } });
        return res.status(200).json(results);
    } catch (error) {
        return sendError(res, error, "replayWorkspaceEvents");
    }
};

export const rerunWorkspaceAttribution = async (req, res) => {
    try {
        const reason = needReason(req, res);
        if (!reason) return;
        const workspaceId = req.params.workspaceId;
        if (!(await orm().Workspace.where({ id: workspaceId }).first())) return res.status(404).json({ message: "Workspace not found", code: "not_found" });
        enqueueJob("attribution.rerun", { workspaceId, from: req.body?.from ?? null, to: req.body?.to ?? null, actorUserId: req.user.id, reason });
        await audit(req, "admin.attribution_rerun", { workspaceId, targetType: "workspace", targetId: workspaceId, reason });
        return res.status(202).json({ message: "Attribution re-run queued", status: "queued" });
    } catch (error) {
        return sendError(res, error, "rerunWorkspaceAttribution");
    }
};

export const rebuildWorkspaceRollups = async (req, res) => {
    try {
        await requestRebuild(req.params.workspaceId);
        await audit(req, "admin.rollups_rebuilt", { workspaceId: req.params.workspaceId, targetType: "workspace", targetId: req.params.workspaceId, reason: reasonOf(req) || null });
        return res.status(202).json({ message: "Rollup rebuild queued", status: "queued" });
    } catch (error) {
        return sendError(res, error, "rebuildWorkspaceRollups");
    }
};

export const rotateKeyForCompany = async (req, res) => {
    try {
        const reason = needReason(req, res);
        if (!reason) return;
        const key = await orm().ApiKey.where({ id: req.params.keyId }).first();
        if (!key) return res.status(404).json({ message: "API key not found", code: "not_found" });
        const out = await rotateKeyRecord(db, { workspaceId: key.workspaceId, keyId: key.id, graceHours: req.body?.graceHours ?? 24, actorUserId: req.user.id });
        await audit(req, "admin.api_key_rotated", { workspaceId: key.workspaceId, targetType: "api_key", targetId: out.created.id, reason, metadata: { rotatedFromId: key.id } });
        // the new key is shown once, to be handed to the company over a secure channel
        return res.status(201).json({ id: out.created.id, key: out.key, previousKeyExpiresAt: out.oldKeyExpiresAt });
    } catch (error) {
        return sendError(res, error, "rotateKeyForCompany");
    }
};

/** Body: { reason, confirm: <workspace slug>, keepAccount?: boolean } */
export const deleteCompanyData = async (req, res) => {
    try {
        const reason = needReason(req, res);
        if (!reason) return;
        const workspace = await orm().Workspace.where({ id: req.params.workspaceId }).first();
        if (!workspace) return res.status(404).json({ message: "Workspace not found", code: "not_found" });
        if (req.body?.confirm !== workspace.slug) return res.status(400).json({ message: `Type the company slug (${workspace.slug}) in "confirm" to delete its data.`, code: "confirmation_required" });
        const out = await purgeWorkspace(workspace.id, { keepAccount: req.body?.keepAccount === true, actorUserId: req.user.id, reason, ip: req.ip, userAgent: req.headers?.["user-agent"] });
        return res.status(200).json({ message: "Company data deleted", ...out });
    } catch (error) {
        return sendError(res, error, "deleteCompanyData");
    }
};

export const listPlatformAuditLog = async (req, res) => {
    try {
        const store = getAuditStore(orm());
        if (!store) return res.status(200).json({ data: [], available: false });
        let rows = (await store.where({ actorType: "platform_admin" }).all()).concat(req.query.all === "true" ? await store.where((l) => l.workspaceId.isNull()).all() : []);
        if (req.query.workspaceId) rows = rows.filter((r) => r.workspaceId === req.query.workspaceId);
        if (req.query.action) rows = rows.filter((r) => String(r.action).startsWith(String(req.query.action)));
        const seen = new Set();
        rows = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
        sortDesc(rows, "createdAt");
        if (wantsCsv(req)) return sendCsv(res, "platform-audit-log.csv", rows, ["createdAt", "workspaceId", "actorUserId", "action", "targetType", "targetId", "reason", "ip"]);
        return res.status(200).json(paginate(rows, req, "createdAt"));
    } catch (error) {
        return sendError(res, error, "platformAuditLog");
    }
};

export const listFxRates = async (req, res) => {
    try {
        let rows = await orm().FxRate.all();
        if (req.query.date) rows = rows.filter((r) => r.date === req.query.date);
        if (req.query.base) rows = rows.filter((r) => r.base === String(req.query.base).toUpperCase());
        sortDesc(rows, "date");
        return res.status(200).json(paginate(rows, req, "date"));
    } catch (error) {
        return sendError(res, error, "listFxRates");
    }
};

/** Body: { rates: [{ date: "2026-10-01", base: "INR", quote: "USD", rate: 0.012 }], backfill?: true } */
export const uploadFxRates = async (req, res) => {
    try {
        const rates = req.body?.rates;
        if (!Array.isArray(rates) || !rates.length || rates.length > 10000) return res.status(400).json({ message: "rates must be a list of 1-10000 rows", code: "validation_error" });
        const written = await upsertRates(orm(), rates, "admin_upload");
        // orders that had no rate yet get the snapshot now (orders that already have one never change)
        let backfilled = 0;
        if (req.body?.backfill !== false) {
            const { findRate } = await import("../services/fx.js");
            const missing = (await orm().Order.where((o) => o.fxRateToReporting.isNull()).all()).slice(0, 20000);
            const touched = new Set();
            for (const o of missing) {
                if (!o.reportingCurrency || o.currency === o.reportingCurrency) continue;
                const rate = await findRate(orm(), String(o.orderedAt).slice(0, 10), o.currency, o.reportingCurrency);
                if (rate) {
                    await orm().Order.where({ id: o.id }).update({ fxRateToReporting: rate });
                    backfilled++;
                    touched.add(o.workspaceId);
                }
            }
            for (const w of touched) await requestRebuild(w);
        }
        // dynamic FX: sales and bookings on the uploaded days follow the new rates (each company's FX mode)
        const { applyRateChanges } = await import("../services/fxRevaluation.js");
        const dates = [...new Set(rates.map((r) => String(r.date)))];
        const currencies = [...new Set(rates.flatMap((r) => [String(r.base).toUpperCase(), String(r.quote).toUpperCase()]))];
        const revalued = await applyRateChanges(dates, currencies);
        await audit(req, "admin.fx_rates_uploaded", { workspaceId: null, metadata: { written, backfilled, ordersRepriced: revalued.ordersRepriced, workspacesRebuilt: revalued.workspacesRebuilt } });
        return res.status(200).json({ written, backfilled, ordersRepriced: revalued.ordersRepriced, workspacesRebuilt: revalued.workspacesRebuilt });
    } catch (error) {
        return sendError(res, error, "uploadFxRates");
    }
};

/** POST /api/platform-admin/jobs/:jobId/retry { reason } — run a dead background job again. */
export const retryBackgroundJob = async (req, res) => {
    try {
        const reason = needReason(req, res);
        if (!reason) return;
        const row = await retryDeadJob(req.params.jobId);
        if (!row) return res.status(404).json({ message: "No dead job with that id", code: "not_found" });
        await audit(req, "admin.job_retried", { workspaceId: row.workspaceId ?? null, targetType: "background_job", targetId: row.id, reason, metadata: { type: row.type } });
        return res.status(202).json({ message: "Job queued again", status: "queued" });
    } catch (error) {
        return sendError(res, error, "retryBackgroundJob");
    }
};
