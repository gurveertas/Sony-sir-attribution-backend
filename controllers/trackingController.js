/**
 * POST /v1/touches
 *
 * Records a visitor touch (page view with attribution data).
 * Called by the site SDK on every page visit.
 *
 * Auth: publishable API key (apiKeyAuth middleware sets req.workspaceId, req.apiKey)
 *
 * Body:
 *   visitorId*    - client-side UUID for this browser/device
 *   touchedAt?    - ISO timestamp (defaults to now)
 *   source?       - utm_source
 *   medium?       - utm_medium
 *   campaign?     - utm_campaign
 *   term?         - utm_term
 *   content?      - utm_content
 *   referrer?     - document.referrer
 *   landingPage?  - window.location.href
 *   pageTitle?    - document.title
 *   gclid?        - Google click ID
 *   fbclid?       - Facebook click ID
 *   ttclid?       - TikTok click ID
 *   msclkid?      - Bing click ID
 *   fbc?          - Facebook browser cookie
 *   fbp?          - Facebook pixel cookie
 *   ga?           - GA cookie
 */

import { db } from "../src/prisma/db.js";
import { classifyChannel } from "../services/attributionEngine.js";

export const recordTouch = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;
        const siteId = req.apiKey?.siteId ?? null;

        const {
            visitorId,
            touchedAt,
            source,
            medium,
            campaign,
            term,
            content,
            referrer,
            landingPage,
            pageTitle,
            gclid,
            fbclid,
            ttclid,
            msclkid,
            fbc,
            fbp,
            ga,
        } = req.body ?? {};

        if (!visitorId || typeof visitorId !== "string" || visitorId.length > 200) {
            return res.status(400).json({ message: "visitorId is required (max 200 chars)" });
        }

        // Upsert visitor record
        const existingVisitor = await db.orm.public.Visitor.where({ workspaceId, visitorId }).first();
        let visitor;
        if (existingVisitor) {
            visitor = existingVisitor;
            await db.orm.public.Visitor.where({ id: visitor.id }).update({ lastSeenAt: new Date().toISOString() });
        } else {
            visitor = await db.orm.public.Visitor.create({
                workspaceId,
                visitorId,
            });
        }

        // Build the touch data
        const touchData = {
            workspaceId,
            visitorId: visitor.id,
            siteId: siteId ?? null,
            source: source ?? null,
            medium: medium ?? null,
            campaign: campaign ?? null,
            term: term ?? null,
            content: content ?? null,
            referrer: referrer ?? null,
            landingPage: landingPage ?? null,
            pageTitle: pageTitle ?? null,
            gclid: gclid ?? null,
            fbclid: fbclid ?? null,
            ttclid: ttclid ?? null,
            msclkid: msclkid ?? null,
            fbc: fbc ?? null,
            fbp: fbp ?? null,
            ga: ga ?? null,
            ip: req.ip ?? null,
            userAgent: req.headers["user-agent"] ?? null,
            touchedAt: touchedAt ? new Date(touchedAt).toISOString() : new Date().toISOString(),
        };

        // Classify channel using UTMs / click IDs
        touchData.channel = classifyChannel(touchData, []);
        const DEDUPE_MS = 30 * 60 * 1000;
        const latest = await db.orm.public.Touch
            .where({ workspaceId, visitorId: visitor.id })
            .first();

        const sameCampaign =
            latest &&
            latest.source === touchData.source &&
            latest.medium === touchData.medium &&
            latest.campaign === touchData.campaign &&
            latest.gclid === touchData.gclid;

        if (latest && sameCampaign && Date.now() - new Date(latest.touchedAt).getTime() < DEDUPE_MS) {
            return res.status(200).json({
                id: latest.id,
                touchId: latest.id,
                visitorId,
                visitorRecordId: visitor.id,
                siteId: latest.siteId ?? null,
                channel: latest.channel,
                touchedAt: latest.touchedAt,
                from: 'same campaign'
            });
        }

        const touch = await db.orm.public.Touch.create(touchData);

        return res.status(201).json({
            id: touch.id,
            touchId: touch.id,
            visitorId,
            visitorRecordId: visitor.id,
            siteId: touch.siteId ?? null,
            channel: touch.channel,
            touchedAt: touch.touchedAt,
        });
    } catch (error) {
        console.error("recordTouch error:", error.message);
        return res.status(500).json({ message: "Internal server error while recording touch" });
    }
};

/**
 * POST /v1/identify
 *
 * Links a visitor to a known customer email/phone.
 * Called after the user provides their contact details (booking form, checkout).
 *
 * Body:
 *   visitorId*  - client-side visitor ID
 *   email?      - user's email
 *   phone?      - user's phone (E.164 preferred)
 */
import { resolveOrCreateCustomer, linkVisitorToCustomer, hashIdentifier } from "../services/identityService.js";

export const identifyVisitor = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;
        const { visitorId, email, phone} = req.body ?? {};

        if (!visitorId) return res.status(400).json({ message: "visitorId is required" });
        if (!email && !phone) return res.status(400).json({ message: "email or phone is required" });

        const { customer, isNew } = await resolveOrCreateCustomer(db, workspaceId, { email, phone });

        await linkVisitorToCustomer(db, workspaceId, visitorId, customer.id);
        const visitor = await db.orm.public.Visitor.where({ workspaceId, visitorId }).first();
        const touches = visitor
            ? await db.orm.public.Touch.where({ visitorId: visitor.id }).all()
            : [];

        return res.status(200).json({
            customerId: customer.id,
            visitorId,
            visitorRecordId: visitor?.id ?? null,
            touchIds: touches.map((touch) => touch.id),
            touchCount: touches.length,
            isNew,
        });
    } catch (error) {
        console.error("identifyVisitor error:", error.message);
        return res.status(500).json({ message: "Internal server error while identifying visitor" });
    }
};

/**
 * POST /v1/checkout-sessions
 *
 * Freezes a visitor's current touches and returns a checkout token.
 * The token should be passed through the payment/booking system so we can
 * link the order back to its marketing source.
 *
 * Body:
 *   visitorId*      - client-side visitor ID
 *   expiresInMs?    - token TTL in milliseconds (default 2 hours)
 */
export const createCheckoutSession = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;
        const { visitorId, expiresInMs = 2 * 60 * 60 * 1000 } = req.body ?? {};

        if (!visitorId) return res.status(400).json({ message: "visitorId is required" });

        // Find visitor
        const visitor = await db.orm.public.Visitor.where({ workspaceId, visitorId }).first();
        if (!visitor) return res.status(404).json({ message: "Visitor not found. Send a touch first." });

        // Get all touches for this visitor
        const touches = await db.orm.public.Touch.where({ visitorId: visitor.id }).all();

        // Freeze the touch snapshot
        const frozenTouches = touches.map(t => ({
            id: t.id,
            channel: t.channel,
            source: t.source,
            medium: t.medium,
            campaign: t.campaign,
            gclid: t.gclid,
            fbclid: t.fbclid,
            touchedAt: t.touchedAt,
        }));

        const expiresAt = new Date(Date.now() + expiresInMs).toISOString();

        const session = await db.orm.public.CheckoutSession.create({
            workspaceId,
            visitorId: visitor.id,
            frozenTouches,
            expiresAt,
        });

        return res.status(201).json({
            checkoutSessionId: session.id,
            token: session.token,
            visitorId,
            visitorRecordId: visitor.id,
            touchIds: frozenTouches.map((touch) => touch.id),
            touchCount: frozenTouches.length,
            expiresAt: session.expiresAt,
        });
    } catch (error) {
        console.error("createCheckoutSession error:", error.message);
        return res.status(500).json({ message: "Internal server error while creating checkout session" });
    }
};
