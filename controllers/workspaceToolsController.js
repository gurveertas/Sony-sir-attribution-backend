/**
 * Company tools — /api/workspace/*  (company_admin unless noted)
 *
 *   GET  /setup-checklist                     onboarding checklist (admin + viewer)
 *   POST /test-events                         run a sample journey in test mode
 *   GET  /events/live                         live feed of incoming events (payload: admins only)
 *   POST /attribution/rerun                   re-run attribution over history (settings / logic changed)
 *   POST /rollups/rebuild                     rebuild the daily rollups
 *   GET  /ad-accounts | POST /ad-accounts/oauth/:platform/start | PATCH|DELETE /ad-accounts/:id
 *   POST /ad-accounts/:id/sync                pull spend now
 *   POST /ad-spend/upload                     CSV upload of spend for any channel
 *   GET  /ad-spend                            spend rows (filter from/to, channel)
 *   GET  /webhooks/:id/deliveries             delivery log;  POST /webhooks/:id/test;  POST /webhooks/:id/rotate-secret
 *   POST /webhooks/deliveries/:deliveryId/retry
 *   GET  /customers/:id/export | POST /customers/:id/erase     privacy requests
 *   GET  /data/export                         company data export (JSON)
 */

import crypto from "crypto";
import { db } from "../src/prisma/db.js";
import { tenantDb } from "../services/tenantDb.js";
import { setupChecklist, runTestEvent, liveFeed } from "../services/onboarding.js";
import { enqueueJob } from "../services/jobs.js";
import { importSpendCsv } from "../services/adSpend.js";
import { authorizationUrl, platformConfigured, syncAccount, completeConnection } from "../services/adPlatforms.js";
import { sendTestEvent, WEBHOOK_EVENT_TYPES } from "../services/webhookDispatcher.js";
import { exportCustomer, eraseCustomer } from "../services/privacy.js";
import { writeAudit } from "../services/audit.js";
import { encryptSecret } from "../utils/crypto.js";
import { sendError, wantsCsv, sendCsv, paginate, sortDesc } from "../services/http.js";
import ENV from "../utils/env.js";
import { requestRebuild } from "../services/rollups.js";

const ws = (req) => req.user.workspaceId;
const auditUser = (req, action, extra = {}) =>
    writeAudit(db.orm.public, { workspaceId: ws(req), actorType: "user", actorUserId: req.user.id, action, ip: req.ip ?? null, userAgent: req.headers?.["user-agent"] ?? null, ...extra });

// ── onboarding ──────────────────────────────────────────────────────────────

export const getSetupChecklist = async (req, res) => {
    try {
        return res.status(200).json(await setupChecklist(ws(req)));
    } catch (error) {
        return sendError(res, error, "setupChecklist");
    }
};

export const postTestEvent = async (req, res) => {
    try {
        const out = await runTestEvent(ws(req), { channelSource: ["google", "facebook", "newsletter"].includes(req.body?.source) ? req.body.source : "google" });
        await auditUser(req, "setup.test_event_sent", { metadata: { ok: out.ok } });
        return res.status(out.ok ? 200 : 422).json(out);
    } catch (error) {
        return sendError(res, error, "testEvent");
    }
};

export const getLiveFeed = async (req, res) => {
    try {
        const data = await liveFeed(ws(req), { since: req.query.since || null, includePayload: req.user.role === "company_admin" && req.query.payload === "true", limit: Math.min(200, parseInt(req.query.limit, 10) || 50) });
        return res.status(200).json({ data, lastUpdated: new Date().toISOString() });
    } catch (error) {
        return sendError(res, error, "liveFeed");
    }
};

// ── re-run / rebuild ────────────────────────────────────────────────────────

export const postRerunAttribution = async (req, res) => {
    try {
        const { from = null, to = null } = req.body ?? {};
        for (const v of [from, to]) if (v && !Number.isFinite(Date.parse(v))) return res.status(400).json({ message: "from/to must be dates", code: "validation_error" });
        enqueueJob("attribution.rerun", { workspaceId: ws(req), from, to, actorUserId: req.user.id, reason: "manual" });
        await auditUser(req, "attribution.rerun_requested", { targetType: "workspace", targetId: ws(req), metadata: { from, to } });
        return res.status(202).json({ message: "Attribution re-run started. Reports update when it finishes.", status: "queued" });
    } catch (error) {
        return sendError(res, error, "rerun");
    }
};

export const postRebuildRollups = async (req, res) => {
    try {
        await requestRebuild(ws(req), "manual");
        return res.status(202).json({ message: "Rollup rebuild started", status: "queued" });
    } catch (error) {
        return sendError(res, error, "rebuild");
    }
};

// ── ad accounts and spend ───────────────────────────────────────────────────

const publicAccount = ({ credentialsEnc, ...a }) => ({ ...a, connected: Boolean(credentialsEnc) });

export const listAdAccounts = async (req, res) => {
    try {
        const t = tenantDb(db, ws(req));
        const rows = await t.AdAccount.all();
        return res.status(200).json({
            data: rows.map(publicAccount),
            platforms: { meta: platformConfigured("meta"), google: platformConfigured("google") },
        });
    } catch (error) {
        return sendError(res, error, "listAdAccounts");
    }
};

export const startAdOAuth = async (req, res) => {
    try {
        const platform = req.params.platform;
        if (!["meta", "google"].includes(platform)) return res.status(400).json({ message: "platform must be meta or google", code: "validation_error" });
        return res.status(200).json({ url: authorizationUrl(platform, { workspaceId: ws(req), userId: req.user.id }) });
    } catch (error) {
        return sendError(res, error, "startAdOAuth");
    }
};

/** GET /api/ad-accounts/oauth/:platform/callback — public: the signed state identifies the company. */
export const adOAuthCallback = async (req, res) => {
    const back = (q) => res.redirect?.(302, `${ENV.FRONTEND_URL}/settings?${new URLSearchParams(q)}#ad-accounts`) ?? res.status(200).json(q);
    try {
        if (req.query.error) return back({ adAccounts: "cancelled" });
        const out = await completeConnection(req.params.platform, { code: req.query.code, state: req.query.state });
        await writeAudit(db.orm.public, { workspaceId: out.workspaceId, actorType: "user", actorUserId: out.userId, action: "ad_account.connected", metadata: { platform: req.params.platform, accounts: out.accounts } });
        for (const a of await tenantDb(db, out.workspaceId).AdAccount.where({ platform: req.params.platform }).all()) enqueueJob("adspend.sync", { workspaceId: out.workspaceId, accountId: a.id });
        return back({ adAccounts: "connected", count: String(out.accounts) });
    } catch (error) {
        console.error("ad oauth callback:", error.message);
        return back({ adAccounts: "error", message: String(error.message).slice(0, 200) });
    }
};

export const updateAdAccount = async (req, res) => {
    try {
        const t = tenantDb(db, ws(req));
        const acct = await t.AdAccount.where({ id: req.params.id }).first();
        if (!acct) return res.status(404).json({ message: "Ad account not found", code: "not_found" });
        const changes = {};
        if (req.body?.status !== undefined) {
            if (!["healthy", "disabled"].includes(req.body.status)) return res.status(400).json({ message: "status must be healthy or disabled", code: "validation_error" });
            changes.status = req.body.status;
        }
        if (req.body?.timezone !== undefined) changes.timezone = req.body.timezone;
        if (req.body?.currency !== undefined) changes.currency = String(req.body.currency).toUpperCase().slice(0, 3);
        if (!Object.keys(changes).length) return res.status(400).json({ message: "Nothing to update", code: "validation_error" });
        await t.AdAccount.where({ id: acct.id }).update(changes);
        await auditUser(req, "ad_account.updated", { targetType: "ad_account", targetId: acct.id, metadata: { changedFields: Object.keys(changes) } });
        return res.status(200).json({ message: "Ad account updated" });
    } catch (error) {
        return sendError(res, error, "updateAdAccount");
    }
};

export const deleteAdAccount = async (req, res) => {
    try {
        const t = tenantDb(db, ws(req));
        const acct = await t.AdAccount.where({ id: req.params.id }).first();
        if (!acct) return res.status(404).json({ message: "Ad account not found", code: "not_found" });
        if (req.query.keepSpend === "true") await t.AdAccount.where({ id: acct.id }).update({ status: "disabled", credentialsEnc: null });
        else {
            await t.AdSpend.where({ adAccountId: acct.id }).delete();
            await t.AdAccount.where({ id: acct.id }).delete();
        }
        await auditUser(req, "ad_account.removed", { targetType: "ad_account", targetId: acct.id });
        await requestRebuild(ws(req));
        return res.status(204).end();
    } catch (error) {
        return sendError(res, error, "deleteAdAccount");
    }
};

export const syncAdAccountNow = async (req, res) => {
    try {
        const out = await syncAccount(ws(req), req.params.id, { days: Math.min(90, Math.max(1, parseInt(req.body?.days, 10) || 7)) });
        return res.status(200).json(out);
    } catch (error) {
        return sendError(res, error, "syncAdAccount");
    }
};

/** Body: { csv: "<text>" } (or text/csv body) */
export const uploadAdSpend = async (req, res) => {
    try {
        const csv = typeof req.body === "string" ? req.body : req.body?.csv;
        if (!csv) return res.status(400).json({ message: "Send the CSV text as { csv }", code: "validation_error" });
        const workspace = await db.orm.public.Workspace.where({ id: ws(req) }).first();
        const out = await importSpendCsv(ws(req), csv, { defaultCurrency: workspace?.reportingCurrency || "USD" });
        await auditUser(req, "ad_spend.uploaded", { metadata: { inserted: out.inserted, updated: out.updated, errors: out.errors.length } });
        return res.status(out.errors.length && !out.inserted && !out.updated ? 400 : 200).json(out);
    } catch (error) {
        return sendError(res, error, "uploadAdSpend");
    }
};

export const listAdSpend = async (req, res) => {
    try {
        const t = tenantDb(db, ws(req));
        let rows = await t.AdSpend.all();
        if (req.query.from) rows = rows.filter((r) => r.date >= String(req.query.from));
        if (req.query.to) rows = rows.filter((r) => r.date <= String(req.query.to));
        if (req.query.channel) rows = rows.filter((r) => r.channel === req.query.channel);
        sortDesc(rows, "date");
        const data = rows.map((r) => ({ ...r, spendMinorUnits: r.spendMinorUnits?.toString() }));
        if (wantsCsv(req)) return sendCsv(res, "ad-spend.csv", data, ["date", "platform", "channel", "campaignName", "adSetName", "adName", "currency", "spendMinorUnits", "impressions", "clicks", "source"]);
        return res.status(200).json(paginate(data, req, "date"));
    } catch (error) {
        return sendError(res, error, "listAdSpend");
    }
};

// ── outbound webhooks: delivery log, test, secret rotation ──────────────────

export const listWebhookDeliveries = async (req, res) => {
    try {
        const t = tenantDb(db, ws(req));
        const ep = await t.WebhookEndpoint.where({ id: req.params.id }).first();
        if (!ep) return res.status(404).json({ message: "Webhook endpoint not found", code: "not_found" });
        let rows = await t.WebhookDelivery.where({ endpointId: ep.id }).all();
        if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
        sortDesc(rows, "createdAt");
        const page = paginate(rows, req, "createdAt");
        page.data = page.data.map(({ payload, ...d }) => ({ ...d, payload: req.query.payload === "true" ? payload : undefined }));
        return res.status(200).json(page);
    } catch (error) {
        return sendError(res, error, "listWebhookDeliveries");
    }
};

export const testWebhook = async (req, res) => {
    try {
        const t = tenantDb(db, ws(req));
        const ep = await t.WebhookEndpoint.where({ id: req.params.id }).first();
        if (!ep) return res.status(404).json({ message: "Webhook endpoint not found", code: "not_found" });
        if (!ep.isActive) return res.status(409).json({ message: "Turn the endpoint on first", code: "conflict" });
        return res.status(200).json(await sendTestEvent(ep));
    } catch (error) {
        return sendError(res, error, "testWebhook");
    }
};

export const retryWebhookDelivery = async (req, res) => {
    try {
        const t = tenantDb(db, ws(req));
        const d = await t.WebhookDelivery.where({ id: req.params.deliveryId }).first();
        if (!d) return res.status(404).json({ message: "Delivery not found", code: "not_found" });
        if (d.status === "succeeded") return res.status(409).json({ message: "Already delivered", code: "conflict" });
        await t.WebhookDelivery.where({ id: d.id }).update({ status: "pending", nextAttemptAt: new Date().toISOString(), attempts: Math.max(0, (d.attempts ?? 0) - 1) });
        enqueueJob("webhook.deliver", { workspaceId: ws(req), deliveryId: d.id });
        return res.status(202).json({ message: "Retry queued" });
    } catch (error) {
        return sendError(res, error, "retryWebhookDelivery");
    }
};

export const rotateWebhookSecret = async (req, res) => {
    try {
        const t = tenantDb(db, ws(req));
        const ep = await t.WebhookEndpoint.where({ id: req.params.id }).first();
        if (!ep) return res.status(404).json({ message: "Webhook endpoint not found", code: "not_found" });
        const signingSecret = `whsec_${crypto.randomBytes(32).toString("hex")}`;
        await t.WebhookEndpoint.where({ id: ep.id }).update({ signingSecretEnc: encryptSecret(signingSecret) });
        await auditUser(req, "webhook.secret_rotated", { targetType: "webhook_endpoint", targetId: ep.id });
        return res.status(200).json({ id: ep.id, signingSecret, message: "Copy the new secret now: it is shown only once." });
    } catch (error) {
        return sendError(res, error, "rotateWebhookSecret");
    }
};

export const listWebhookEventTypes = (req, res) => res.status(200).json({ data: WEBHOOK_EVENT_TYPES.filter((t) => t !== "ping") });

// ── privacy ─────────────────────────────────────────────────────────────────

export const exportCustomerData = async (req, res) => {
    try {
        const data = await exportCustomer(ws(req), req.params.id);
        if (!data) return res.status(404).json({ message: "Customer not found", code: "not_found" });
        await auditUser(req, "customer.exported", { targetType: "customer", targetId: req.params.id });
        res.setHeader("Content-Disposition", `attachment; filename="customer-${req.params.id}.json"`);
        return res.status(200).json(data);
    } catch (error) {
        return sendError(res, error, "exportCustomer");
    }
};

export const eraseCustomerData = async (req, res) => {
    try {
        if (req.body?.confirm !== true) return res.status(400).json({ message: "Send { confirm: true } to erase this customer's personal data. This cannot be undone.", code: "confirmation_required" });
        const out = await eraseCustomer(ws(req), req.params.id, { actorUserId: req.user.id, reason: String(req.body?.reason ?? "").slice(0, 500) || null, ip: req.ip, userAgent: req.headers?.["user-agent"] });
        if (!out) return res.status(404).json({ message: "Customer not found", code: "not_found" });
        return res.status(200).json({ message: "Personal data erased. Revenue history is kept without identifying details.", ...out });
    } catch (error) {
        return sendError(res, error, "eraseCustomer");
    }
};

/** GET /api/workspace/data/export?include=orders,bookings,refunds,customers,touches (JSON, admin only) */
export const exportWorkspaceData = async (req, res) => {
    try {
        const t = tenantDb(db, ws(req));
        const include = String(req.query.include || "orders,bookings,refunds,customers").split(",");
        const out = { exportedAt: new Date().toISOString(), workspaceId: ws(req) };
        const strip = ({ emailEnc, emailHash, phoneHash, rawPayload, ...r }) => r;
        if (include.includes("orders")) out.orders = (await t.Order.all()).map(strip);
        if (include.includes("bookings")) out.bookings = (await t.Booking.all()).map(strip);
        if (include.includes("refunds")) out.refunds = await t.Refund.all();
        if (include.includes("customers")) out.customers = (await t.Customer.all()).map(strip);
        if (include.includes("touches")) out.touches = await t.Touch.all();
        if (include.includes("credits")) out.credits = await t.AttributionCredit.all();
        await auditUser(req, "workspace.data_exported", { metadata: { include } });
        res.setHeader("Content-Disposition", `attachment; filename="export-${ws(req)}.json"`);
        return res.status(200).json(JSON.parse(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : Buffer.isBuffer(v) ? undefined : v))));
    } catch (error) {
        return sendError(res, error, "exportWorkspaceData");
    }
};
