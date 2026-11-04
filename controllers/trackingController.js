/**
 * SDK tracking endpoints (publishable key, browser) — DFD processes 2.0 (touches) and 3.0 (tokens).
 *
 *   POST /v1/touches            one visit with its source
 *   POST /v1/identify           link the visitor to an email / phone
 *   POST /v1/checkout-sessions  freeze the visitor's touches, return the checkout token
 *
 * Consent (scope 4.2 / 4.10): with consentMode "opt_in" nothing is stored unless the SDK says
 * consent was granted; with "opt_out" nothing is stored once the visitor refused.
 */

import crypto from "crypto";
import { db } from "../src/prisma/db.js";
import { tenantDb } from "../services/tenantDb.js";
import { classifyChannel, isInternalReferrer, hasClickId } from "../services/attributionEngine.js";
import { resolveCustomer, linkVisitorToCustomer, ensureVisitor } from "../services/identityService.js";
import { sendError } from "../services/http.js";

const SAME_TOUCH_MS = 30 * 60 * 1000;
const RULES_TTL_MS = 60_000;
const rulesCache = new Map(); // workspaceId -> { at, rules, consentMode }

const clip = (v, max = 2000) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, max));

async function trackingContext(workspaceId) {
    const hit = rulesCache.get(workspaceId);
    if (hit && Date.now() - hit.at < RULES_TTL_MS) return hit;
    const [workspace, rules] = await Promise.all([
        db.orm.public.Workspace.where({ id: workspaceId }).first(),
        db.orm.public.ChannelMappingRule.where({ workspaceId }).all(),
    ]);
    const entry = { at: Date.now(), rules: rules.filter((r) => r.isActive !== false), consentMode: workspace?.consentMode ?? "off" };
    rulesCache.set(workspaceId, entry);
    return entry;
}

/** Drop cached rules after a settings / channel-rule change. */
export const invalidateTrackingCache = (workspaceId) => rulesCache.delete(workspaceId);

/** @returns {string|null} why tracking must not store anything */
function consentBlock(consentMode, consent) {
    if (consentMode === "opt_in" && consent !== true && consent !== "granted") return "consent_required";
    if (consentMode === "opt_out" && (consent === false || consent === "denied")) return "consent_denied";
    return null;
}

function validVisitorId(v) {
    return typeof v === "string" && v.length > 0 && v.length <= 200;
}

/**
 * POST /v1/touches
 * Body: visitorId*, touchedAt?, source, medium, campaign, term, content (UTMs), referrer, landingPage,
 *       pageTitle, gclid, fbclid, ttclid, msclkid, fbc, fbp, ga, consent?
 */
export const recordTouch = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;
        const t = tenantDb(db, workspaceId);
        const b = req.body ?? {};
        if (!validVisitorId(b.visitorId)) return res.status(400).json({ message: "visitorId is required (max 200 chars)", code: "validation_error" });
        if (b.touchedAt !== undefined && !Number.isFinite(Date.parse(b.touchedAt))) {
            return res.status(400).json({ message: "touchedAt must be an ISO timestamp", code: "validation_error" });
        }

        const { rules, consentMode } = await trackingContext(workspaceId);
        const blocked = consentBlock(consentMode, b.consent);
        if (blocked) return res.status(202).json({ stored: false, reason: blocked });

        const touchData = {
            siteId: req.apiKey?.siteId ?? null,
            source: clip(b.source, 300),
            medium: clip(b.medium, 300),
            campaign: clip(b.campaign, 300),
            term: clip(b.term, 300),
            content: clip(b.content, 300),
            referrer: clip(b.referrer),
            landingPage: clip(b.landingPage),
            pageTitle: clip(b.pageTitle, 500),
            gclid: clip(b.gclid, 500),
            fbclid: clip(b.fbclid, 500),
            ttclid: clip(b.ttclid, 500),
            msclkid: clip(b.msclkid, 500),
            fbc: clip(b.fbc, 500),
            fbp: clip(b.fbp, 500),
            ga: clip(b.ga, 500),
            ip: null, // not stored: personal data, not needed for deterministic matching
            userAgent: clip(req.headers["user-agent"], 500),
            isTest: req.apiKey?.mode === "test",
            touchedAt: new Date(b.touchedAt ?? Date.now()).toISOString(),
        };

        // A click on an internal link (same-site referrer, no campaign data) is not a new touch.
        const hasCampaign = touchData.source || touchData.medium || touchData.campaign || hasClickId(touchData);
        if (!hasCampaign && touchData.referrer && isInternalReferrer(touchData)) {
            return res.status(200).json({ stored: false, reason: "internal_navigation", visitorId: b.visitorId });
        }

        const visitor = await ensureVisitor(db, workspaceId, b.visitorId);
        await t.Visitor.where({ id: visitor.id }).update({ lastSeenAt: new Date().toISOString() });
        touchData.visitorId = visitor.id;
        touchData.channel = classifyChannel(touchData, rules);

        // the same campaign landing again within 30 minutes is the same visit
        const recent = await t.Touch.where({ visitorId: visitor.id }).orderBy((x) => x.touchedAt.desc()).limit(1).all();
        const latest = recent[0];
        if (
            latest &&
            latest.channel === touchData.channel &&
            latest.source === touchData.source &&
            latest.medium === touchData.medium &&
            latest.campaign === touchData.campaign &&
            (latest.gclid ?? null) === touchData.gclid &&
            (latest.fbclid ?? null) === touchData.fbclid &&
            Math.abs(new Date(touchData.touchedAt) - new Date(latest.touchedAt)) < SAME_TOUCH_MS
        ) {
            return res.status(200).json({
                id: latest.id,
                touchId: latest.id,
                visitorId: b.visitorId,
                visitorRecordId: visitor.id,
                siteId: latest.siteId ?? null,
                channel: latest.channel,
                touchedAt: latest.touchedAt,
                deduplicated: true,
            });
        }

        const touch = await t.Touch.create(touchData);
        return res.status(201).json({
            id: touch.id,
            touchId: touch.id,
            visitorId: b.visitorId,
            visitorRecordId: visitor.id,
            siteId: touch.siteId ?? null,
            channel: touch.channel,
            touchedAt: touch.touchedAt,
        });
    } catch (error) {
        return sendError(res, error, "recordTouch");
    }
};

/**
 * POST /v1/identify — Body: visitorId*, email? phone? (one required), consent?
 * Links this browser to the customer; one customer can have many visitors (phone + laptop).
 */
export const identifyVisitor = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;
        const t = tenantDb(db, workspaceId);
        const { visitorId, email, phone, consent } = req.body ?? {};
        if (!validVisitorId(visitorId)) return res.status(400).json({ message: "visitorId is required", code: "validation_error" });
        if (!email && !phone) return res.status(400).json({ message: "email or phone is required", code: "validation_error" });

        const { consentMode } = await trackingContext(workspaceId);
        const blocked = consentBlock(consentMode, consent);
        if (blocked) return res.status(202).json({ stored: false, reason: blocked });

        const { customer, isNew } = await resolveCustomer(db, workspaceId, { email, phone });
        if (!customer) return res.status(400).json({ message: "email or phone is not valid", code: "validation_error" });
        const visitor = await linkVisitorToCustomer(db, workspaceId, visitorId, customer.id);
        const touches = await t.Touch.where({ visitorId: visitor.id }).all();

        return res.status(200).json({
            customerId: customer.id,
            visitorId,
            visitorRecordId: visitor.id,
            touchIds: touches.map((x) => x.id),
            touchCount: touches.length,
            isNew,
        });
    } catch (error) {
        return sendError(res, error, "identifyVisitor");
    }
};

const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000; // bookings and slow payments complete days later
const MAX_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * POST /v1/checkout-sessions — Body: visitorId*, expiresInMs? (default 7 days, max 30 days)
 *
 * Token rules:
 *   - every call issues a NEW token with its own frozen snapshot; earlier tokens stay valid until
 *     they expire or are used, so a visitor who abandons checkout and returns later gets a fresh
 *     snapshot that includes the newer touches (e.g. the retargeting ad);
 *   - a token is used once: the first order (or booking) that presents it consumes it, and the
 *     invoice of that booking inherits the booking's credit;
 *   - the lookback window is applied to the frozen touches at conversion time.
 */
export const createCheckoutSession = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;
        const t = tenantDb(db, workspaceId);
        const { visitorId, expiresInMs, consent } = req.body ?? {};
        if (!validVisitorId(visitorId)) return res.status(400).json({ message: "visitorId is required", code: "validation_error" });
        const ttl = expiresInMs === undefined ? DEFAULT_TOKEN_TTL_MS : Number(expiresInMs);
        if (!Number.isFinite(ttl) || ttl < 60_000 || ttl > MAX_TOKEN_TTL_MS) {
            return res.status(400).json({ message: "expiresInMs must be between 60000 (1 minute) and 2592000000 (30 days)", code: "validation_error" });
        }

        const { consentMode } = await trackingContext(workspaceId);
        const blocked = consentBlock(consentMode, consent);
        if (blocked) return res.status(202).json({ stored: false, reason: blocked, token: null });

        const visitor = await ensureVisitor(db, workspaceId, visitorId);
        const touches = (await t.Touch.where({ visitorId: visitor.id }).all()).sort((a, b) => new Date(a.touchedAt) - new Date(b.touchedAt));
        const frozenTouches = touches.map((x) => ({
            id: x.id,
            channel: x.channel,
            source: x.source,
            medium: x.medium,
            campaign: x.campaign,
            gclid: x.gclid,
            fbclid: x.fbclid,
            touchedAt: x.touchedAt,
        }));

        const session = await t.CheckoutSession.create({
            token: crypto.randomUUID(),
            visitorId: visitor.id,
            frozenTouches,
            expiresAt: new Date(Date.now() + ttl).toISOString(),
        });

        return res.status(201).json({
            checkoutSessionId: session.id,
            token: session.token,
            visitorId,
            visitorRecordId: visitor.id,
            touchIds: frozenTouches.map((x) => x.id),
            touchCount: frozenTouches.length,
            expiresAt: session.expiresAt,
        });
    } catch (error) {
        return sendError(res, error, "createCheckoutSession");
    }
};
