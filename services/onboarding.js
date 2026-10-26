/**
 * Self-serve onboarding (scope 4.1): the setup checklist and the test-event tool, so a new company
 * can go live in under 30 minutes without our help.
 *
 * Checklist: verify email -> verify domain -> create keys -> install SDK -> connect a system ->
 *            send a test event -> go live (first live conversion).
 */

import crypto from "crypto";
import { db } from "../src/prisma/db.js";
import { tenantDb } from "./tenantDb.js";
import { ingestOrder } from "./ingestion.js";
import { classifyChannel } from "./attributionEngine.js";
import { ensureVisitor } from "./identityService.js";

export async function setupChecklist(workspaceId, client = db) {
    const t = tenantDb(client, workspaceId);
    const workspace = await client.orm.public.Workspace.where({ id: workspaceId }).first();
    const [sites, keys, connectors, touches, orders, bookings, raws] = await Promise.all([
        t.Site.all(),
        t.ApiKey.all(),
        t.Connector.all(),
        t.Touch.where({ workspaceId }).orderBy((x) => x.touchedAt.desc()).limit(50).all(),
        t.Order.where({ workspaceId }).orderBy((x) => x.orderedAt.desc()).limit(50).all(),
        t.Booking.where({ workspaceId }).limit(50).all(),
        t.RawEvent.where({ workspaceId }).limit(50).all(),
    ]);
    const activeKeys = keys.filter((k) => !k.revokedAt && !(k.expiresAt && new Date(k.expiresAt) < new Date()));
    const liveTouches = touches.filter((x) => !x.isTest);
    const steps = [
        { key: "verify_email", label: "Verify your email", done: !workspace?.emailVerificationHash },
        { key: "verify_domain", label: "Verify your website domain (DNS TXT record or meta tag)", done: sites.some((s) => s.verifiedAt), action: "/settings#sites" },
        { key: "create_keys", label: "Create a publishable key (website) and a secret key (server)", done: activeKeys.some((k) => k.type === "publishable") && activeKeys.some((k) => k.type === "secret"), action: "/settings#api-keys" },
        { key: "install_sdk", label: "Install the tracking script on your website", done: touches.length > 0, detail: touches[0] ? `Last visit recorded ${touches[0].touchedAt}` : null, action: "/docs#sdk" },
        { key: "connect_system", label: "Connect your payment, booking or store system", done: connectors.some((c) => c.status !== "disabled") || orders.some((o) => !o.connectorId), action: "/settings#connectors" },
        { key: "send_test_event", label: "Send a test event and see it arrive", done: orders.some((o) => o.isTest) || raws.some((r) => r.isTest) || touches.some((x) => x.isTest), action: "/settings#test-event" },
        { key: "go_live", label: "First live conversion attributed", done: orders.some((o) => !o.isTest) || bookings.some((b) => !b.isTest), detail: liveTouches.length ? null : "Waiting for live website traffic" },
    ];
    const next = steps.find((s) => !s.done) ?? null;
    return { steps, completed: steps.filter((s) => s.done).length, total: steps.length, next: next?.key ?? null, live: steps.every((s) => s.done), status: workspace?.status };
}

/**
 * Runs a sample journey in TEST mode through the real pipeline and explains each step in plain
 * language: touch -> checkout token -> order with the token -> attribution. Test data is excluded
 * from every report.
 */
export async function runTestEvent(workspaceId, { channelSource = "google", amount = 49.99, currency } = {}, client = db) {
    const t = tenantDb(client, workspaceId);
    const workspace = await client.orm.public.Workspace.where({ id: workspaceId }).first();
    const steps = [];
    const visitorId = `test_${crypto.randomUUID()}`;
    const cur = currency || workspace?.reportingCurrency || "USD";
    try {
        const visitor = await ensureVisitor(client, workspaceId, visitorId);
        const touchData = {
            visitorId: visitor.id,
            source: channelSource,
            medium: "cpc",
            campaign: "setup-test",
            landingPage: workspace?.websiteUrl ? `${workspace.websiteUrl}/?utm_source=${channelSource}&utm_medium=cpc&utm_campaign=setup-test` : null,
            gclid: channelSource === "google" ? `test-${crypto.randomBytes(6).toString("hex")}` : null,
            isTest: true,
            touchedAt: new Date(Date.now() - 60_000).toISOString(),
        };
        touchData.channel = classifyChannel(touchData, []);
        const touch = await t.Touch.create(touchData);
        steps.push({ step: "touch", ok: true, message: `Visit recorded from ${touch.channel} (campaign "setup-test").`, id: touch.id });

        const session = await t.CheckoutSession.create({ token: crypto.randomUUID(), visitorId: visitor.id, frozenTouches: [{ id: touch.id, channel: touch.channel, touchedAt: touch.touchedAt }], expiresAt: new Date(Date.now() + 3600_000).toISOString() });
        steps.push({ step: "checkout_token", ok: true, message: "Checkout token created and the visit frozen into it.", token: session.token });

        const result = await ingestOrder(workspaceId, { externalId: `test-order-${crypto.randomUUID()}`, orderedAt: new Date().toISOString(), currency: cur, grossAmount: amount, checkoutToken: session.token }, { isTest: true, client });
        const ok = result.statusCode === 201 && result.body.matchMethod === "token";
        steps.push({
            step: "order",
            ok,
            message: ok ? `Test order received and matched by checkout token to ${touch.channel}.` : `The order was stored but not matched (${result.body.attributionReason ?? result.body.matchMethod}).`,
            orderId: result.body.orderId,
            matchMethod: result.body.matchMethod,
        });
        return { ok, steps, note: "Test data is marked as test and never appears in reports." };
    } catch (err) {
        steps.push({ step: "error", ok: false, message: explain(err) });
        return { ok: false, steps };
    }
}

/** Plain-language versions of the errors a setup most often hits. */
export function explain(err) {
    const m = String(err?.message ?? err);
    if (/currency/i.test(m)) return "The currency must be a 3-letter code such as USD, INR or AED.";
    if (/externalId/i.test(m)) return "Every order needs your own order id (externalId) so we never count it twice.";
    if (/orderedAt/i.test(m)) return "The order needs the time it was paid (orderedAt), as an ISO timestamp like 2026-10-26T10:00:00Z.";
    if (/not verified|site_unverified/i.test(m)) return "Live keys only work after your website domain is verified. Use a test key until then.";
    if (/origin/i.test(m)) return "The request came from a website that is not on the key's allowed origins.";
    if (/signature/i.test(m)) return "The webhook signature did not match. Check that the signing secret in your payment system matches the one shown when you connected it.";
    return m;
}

/** Live feed: the newest events of every kind (payload only for company admins). */
export async function liveFeed(workspaceId, { since = null, includePayload = false, limit = 50 } = {}, client = db) {
    const t = tenantDb(client, workspaceId);
    const after = since ? new Date(since) : new Date(Date.now() - 24 * 3600_000);
    const raws = (await t.RawEvent.where((e) => e.receivedAt.gte(after.toISOString())).orderBy((e) => e.receivedAt.desc()).limit(limit).all()).map((e) => ({
        kind: "event",
        id: e.id,
        at: e.receivedAt,
        source: e.source,
        type: e.eventType,
        status: e.status,
        error: e.error ? explain({ message: e.error }) : null,
        isTest: Boolean(e.isTest),
        ...(includePayload ? { payload: e.payload } : {}),
    }));
    const touches = (await t.Touch.where((x) => x.touchedAt.gte(after.toISOString())).orderBy((x) => x.touchedAt.desc()).limit(limit).all()).map((x) => ({
        kind: "touch",
        id: x.id,
        at: x.touchedAt,
        source: "sdk",
        type: "touch",
        channel: x.channel,
        campaign: x.campaign,
        status: "processed",
        isTest: Boolean(x.isTest),
    }));
    return [...raws, ...touches].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}
