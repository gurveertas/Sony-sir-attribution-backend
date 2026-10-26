// Security, privacy, onboarding and platform-admin behaviour added for scope sections 4.1, 4.3, 4.8-4.10.
import { mockFetch } from "./setup.js";
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createFakeDb, makeRes } from "./fakeDb.js";

const fake = createFakeDb();
mock.module("../src/prisma/db.js", { namedExports: { db: fake.db }, defaultExport: fake.db });

const users = await import("../controllers/userController.js");
const auth = await import("../controllers/authController.js");
const tools = await import("../controllers/workspaceToolsController.js");
const platform = await import("../controllers/platformToolsController.js");
const keys = await import("../controllers/apiKeyController.js");
const reports = await import("../controllers/reportsController.js");
const { idempotency, recordRawEvent } = await import("../middlewares/apiWrite.js");
const { createOrder } = await import("../controllers/orderController.js");
const { ingestOrder } = await import("../services/ingestion.js");
const { dispatchWebhook, deliver } = await import("../services/webhookDispatcher.js");
const { drainJobs } = await import("../services/jobs.js");
const { totp } = await import("../utils/totp.js");
const { encryptSecret } = await import("../utils/crypto.js");
const bcrypt = (await import("bcryptjs")).default;

const T = fake.tables;
const db = fake.db;

beforeEach(async () => {
    await drainJobs();
    for (const k of Object.keys(T)) T[k] = [];
    T.Workspace = [
        { id: "ws1", slug: "acme-1", name: "Acme", timezone: "UTC", reportingCurrency: "USD", status: "active", defaultModel: "last_non_direct", lookbackDays: 30 },
        { id: "ws2", slug: "beta-2", name: "Beta", timezone: "UTC", reportingCurrency: "USD", status: "active" },
    ];
});

const admin = (over = {}) => ({ id: "admin1", role: "company_admin", workspaceId: "ws1", ...over });
const call = async (fn, req) => {
    const res = makeRes();
    await fn({ headers: {}, ip: "1.2.3.4", query: {}, params: {}, body: {}, ...req }, res);
    return res;
};

// ── user management ─────────────────────────────────────────────────────────
test("company admins can only manage their own company's users and can never create or grant platform_admin", async () => {
    T.User = [
        { id: "admin1", workspaceId: "ws1", role: "company_admin", status: "active", email: "a@acme.co" },
        { id: "other", workspaceId: "ws2", role: "company_admin", status: "active", email: "b@beta.co" },
        { id: "viewer1", workspaceId: "ws1", role: "company_viewer", status: "active", email: "v@acme.co" },
    ];
    let res = await call(users.updateMember, { user: admin(), params: { userId: "other" }, body: { role: "company_viewer" } });
    assert.equal(res.statusCode, 404, "another company's user is invisible");
    res = await call(users.updateMember, { user: admin(), params: { userId: "viewer1" }, body: { role: "platform_admin" } });
    assert.equal(res.statusCode, 400);
    res = await call(users.deleteUser, { user: admin(), params: { userId: "other" } });
    assert.equal(res.statusCode, 404);
    assert.equal(T.User.length, 3);
    res = await call(users.addMember, { user: admin(), body: { name: "X", email: "x@acme.co", password: "longpassword1", role: "platform_admin" } });
    assert.equal(res.statusCode, 400);
    res = await call(users.addMember, { user: admin(), body: { name: "X", email: "x@acme.co", password: "short", role: "company_viewer" } });
    assert.equal(res.statusCode, 400, "password policy applies");
    res = await call(users.addMember, { user: admin({ role: "company_viewer" }), body: { name: "X", email: "y@acme.co", password: "longpassword1", role: "company_viewer" } });
    assert.equal(res.statusCode, 403);
    res = await call(users.updateMember, { user: admin(), params: { userId: "viewer1" }, body: { role: "company_admin" } });
    assert.equal(res.statusCode, 200);
    assert.ok(T.AuditLog.some((a) => a.action === "user.updated" && a.targetId === "viewer1"));
    // the last active admin cannot be removed
    T.User = T.User.filter((u) => u.id !== "viewer1");
    T.User.push({ id: "solo", workspaceId: "ws3", role: "company_admin", status: "active" });
    res = await call(users.updateMember, { user: { id: "p", role: "platform_admin", workspaceId: null }, params: { userId: "solo" }, body: { status: "deactivated" } });
    assert.equal(res.statusCode, 409);
});

// ── login throttling, lock-out and two-factor ───────────────────────────────
test("login: wrong passwords lock the account; 2FA users get a challenge and need a valid code", async () => {
    T.User = [{ id: "u1", workspaceId: "ws1", role: "company_admin", status: "active", email: "u@acme.co", passwordHash: await bcrypt.hash("CorrectHorse9"), failedLoginCount: 0 }];
    for (let i = 0; i < 5; i++) await call(auth.companyLogin, { body: { email: "u@acme.co", password: "nope" }, ip: `9.9.9.${i}` });
    let res = await call(auth.companyLogin, { body: { email: "u@acme.co", password: "CorrectHorse9" }, ip: "9.9.9.99" });
    assert.equal(res.statusCode, 423, "locked after 5 failures");
    assert.ok(T.AuditLog.some((a) => a.action === "auth.account_locked"));

    T.User[0].lockedUntil = null;
    const secret = "JBSWY3DPEHPK3PXP";
    Object.assign(T.User[0], { twoFactorEnabled: true, twoFactorSecretEnc: encryptSecret(secret) });
    res = await call(auth.companyLogin, { body: { email: "u@acme.co", password: "CorrectHorse9" }, ip: "8.8.8.8" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.twoFactorRequired, true);
    const bad = await call(auth.verifyTwoFactorLogin, { body: { challengeToken: res.body.challengeToken, code: "000000" } });
    assert.equal(bad.statusCode, 401);
    const cookies = [];
    const good = makeRes();
    good.cookie = (n, v) => cookies.push([n, v]);
    await auth.verifyTwoFactorLogin({ headers: {}, ip: "8.8.8.8", body: { challengeToken: res.body.challengeToken, code: totp(secret) } }, good);
    assert.equal(good.statusCode, 200, JSON.stringify(good.body));
    assert.equal(cookies[0][0], "user_token");
    assert.ok(T.AuditLog.some((a) => a.action === "auth.login" && a.metadata?.twoFactor));
});

test("password reset never reveals whether an account exists", async () => {
    const res = await call(auth.forgotPass, { body: { email: "nobody@nowhere.co" } });
    assert.equal(res.statusCode, 200);
});

// ── idempotency and async API writes ────────────────────────────────────────
test("Idempotency-Key: a retry gets the first answer; the same key with a different body is refused", async () => {
    const mw = idempotency();
    const run = async (body, key = "k-1") => {
        const req = { method: "POST", baseUrl: "/v1", path: "/orders", originalUrl: "/v1/orders", headers: { "idempotency-key": key }, body, workspaceId: "ws1", apiKey: { mode: "live" }, ip: null, query: {} };
        const res = makeRes();
        res.headers = {};
        res.setHeader = (k, v) => (res.headers[k] = v);
        await new Promise((resolve) => {
            const orig = res.json.bind(res);
            res.json = (b) => (orig(b), resolve(), res);
            mw(req, res, () => createOrder(req, res));
        });
        await new Promise((r) => setImmediate(r));
        return res;
    };
    const body = { externalId: "idem-1", orderedAt: "2026-03-01T00:00:00Z", currency: "USD", grossAmount: 5 };
    const first = await run(body);
    assert.equal(first.statusCode, 201);
    const again = await run(body);
    assert.equal(again.statusCode, 201);
    assert.equal(again.headers["Idempotent-Replayed"], "true");
    assert.equal(again.body.orderId, first.body.orderId);
    const misuse = await run({ ...body, grossAmount: 6 });
    assert.equal(misuse.statusCode, 422);
});

test("Prefer: respond-async stores the raw event and answers 202; the queue then processes it", async () => {
    const mw = recordRawEvent("order.paid");
    const req = { method: "POST", headers: { prefer: "respond-async" }, body: { externalId: "async-1", orderedAt: "2026-03-01T00:00:00Z", currency: "USD", grossAmount: 5 }, workspaceId: "ws1", apiKey: { mode: "live" }, query: {} };
    const res = makeRes();
    await mw(req, res, () => assert.fail("must not process inline"));
    assert.equal(res.statusCode, 202);
    await drainJobs();
    assert.equal(T.RawEvent[0].status, "processed");
    assert.equal(T.Order[0].externalId, "async-1");
});

// ── outbound webhooks ───────────────────────────────────────────────────────
test("outbound webhooks are signed (HMAC over timestamp.body), logged, and retried on 5xx", async () => {
    T.WebhookEndpoint = [{ id: "ep1", workspaceId: "ws1", url: "https://hooks.example.com/x", eventTypes: ["order.attributed"], isActive: true, signingSecretEnc: encryptSecret("whsec_test"), consecutiveFailures: 0 }];
    let status = 500;
    const f = mockFetch(() => ({ status, json: {} }));
    try {
        dispatchWebhook("ws1", "order.attributed", { orderId: "o1" });
        await new Promise((r) => setTimeout(r, 20));
        await drainJobs();
        const d = T.WebhookDelivery[0];
        assert.equal(d.status, "pending", "5xx is retried later");
        assert.ok(d.nextAttemptAt);
        const call0 = f.calls[0];
        const [, ts, sig] = call0.headers["X-Webhook-Signature-V2"].match(/^t=(\d+),v1=([a-f0-9]+)$/);
        assert.equal(sig, crypto.createHmac("sha256", "whsec_test").update(`${ts}.${call0.body}`).digest("hex"));
        status = 200;
        assert.equal(await deliver(d.id), "succeeded");
        assert.equal(T.WebhookDelivery[0].attempts, 2);
    } finally {
        f.restore();
    }
});

// ── privacy ─────────────────────────────────────────────────────────────────
test("erasing a customer removes personal data but keeps revenue and its channel credit", async () => {
    const v = await db.orm.public.Visitor.create({ workspaceId: "ws1", visitorId: "pv" });
    const g = await db.orm.public.Touch.create({ workspaceId: "ws1", visitorId: v.id, gclid: "g", channel: "google", touchedAt: "2026-03-01T00:00:00Z" });
    await db.orm.public.CheckoutSession.create({ workspaceId: "ws1", token: "tk", visitorId: v.id, frozenTouches: [{ id: g.id }], expiresAt: "2027-01-01T00:00:00Z" });
    const o = await ingestOrder("ws1", { externalId: "p1", orderedAt: "2026-03-02T00:00:00Z", currency: "USD", grossAmount: 100, checkoutToken: "tk", email: "erase@me.co" });
    T.Visitor[0].customerId = o.body.customerId;
    const res = await call(tools.eraseCustomerData, { user: admin(), params: { id: o.body.customerId }, body: { confirm: true, reason: "GDPR request #12" } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const c = T.Customer[0];
    assert.deepEqual([c.emailHash, c.emailEnc, c.phoneHash], [null, null, null]);
    assert.ok(c.erasedAt);
    assert.equal(T.Touch.length, 0);
    assert.equal(T.Order.length, 1);
    assert.ok(T.AttributionCredit.filter((x) => x.model === "last_touch").every((x) => x.channel === "google" && x.touchId === null));
    const s = await call(reports.getChannelsReport, { workspaceId: "ws1", user: admin(), query: { from: "2026-03-01", to: "2026-03-31" } });
    assert.equal(s.body.data.find((r) => r.channel === "google").netMinorUnits, "10000");
});

// ── onboarding ──────────────────────────────────────────────────────────────
test("setup checklist and the test-event tool (test data never reaches reports)", async () => {
    let res = await call(tools.getSetupChecklist, { user: admin() });
    assert.equal(res.body.next, "verify_domain");
    res = await call(tools.postTestEvent, { user: admin(), body: {} });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.steps.map((s) => s.ok), [true, true, true]);
    res = await call(tools.getSetupChecklist, { user: admin() });
    assert.equal(res.body.steps.find((s) => s.key === "send_test_event").done, true);
    const s = await call(reports.getSummaryReport, { workspaceId: "ws1", user: admin(), query: {} });
    assert.equal(s.body.orders.total, 0, "test orders are excluded");
});

// ── keys ────────────────────────────────────────────────────────────────────
test("rotating a key keeps its type and mode, with a grace period for the old key", async () => {
    T.ApiKey = [{ id: "k1", workspaceId: "ws1", type: "secret", mode: "live", name: "server", keyHash: "h", allowedOrigins: [], rateLimitPerMin: 600, revokedAt: null, createdAt: "2026-01-01" }];
    const res = await call(keys.rotateApiKey, { user: admin(), params: { id: "k1" }, body: { graceHours: 2 } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.type, "secret");
    assert.match(res.body.key, /^sk_live_/);
    assert.ok(T.ApiKey[0].expiresAt && !T.ApiKey[0].revokedAt);
});

// ── ad spend and CAC ────────────────────────────────────────────────────────
test("ad spend CSV upload feeds CAC per channel, ROAS and cost per booking", async () => {
    const csv = "date,channel,campaign,spend,currency,impressions,clicks\n2026-03-01,google,Brand,50.00,USD,1000,40\n2026-03-01,meta,Retarget,30,USD,800,20\n2026-03-02,google,Brand,50,USD,900,30\n";
    let res = await call(tools.uploadAdSpend, { user: admin(), body: { csv } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.inserted, 3);
    res = await call(tools.uploadAdSpend, { user: admin(), body: { csv } });
    assert.equal(res.body.updated, 3, "re-uploading the same day replaces it");

    const v = await db.orm.public.Visitor.create({ workspaceId: "ws1", visitorId: "cv" });
    const g = await db.orm.public.Touch.create({ workspaceId: "ws1", visitorId: v.id, gclid: "g", channel: "google", campaign: "Brand", touchedAt: "2026-03-01T00:00:00Z" });
    await db.orm.public.CheckoutSession.create({ workspaceId: "ws1", token: "ct", visitorId: v.id, frozenTouches: [{ id: g.id }], expiresAt: "2027-01-01T00:00:00Z" });
    await ingestOrder("ws1", { externalId: "cac1", orderedAt: "2026-03-02T00:00:00Z", currency: "USD", grossAmount: 400, checkoutToken: "ct", email: "n@c.co" });
    const cac = await call(reports.getCacReport, { workspaceId: "ws1", user: admin(), query: { from: "2026-03-01", to: "2026-03-31" } });
    assert.equal(cac.statusCode, 200, JSON.stringify(cac.body));
    assert.equal(cac.body.spendMinorUnits, "13000");
    assert.equal(cac.body.blendedCacMinorUnits, "13000");
    const google = cac.body.byChannel.find((c) => c.channel === "google");
    assert.equal(google.cacMinorUnits, "10000");
    assert.equal(google.roas, 4);
    // every report exports as CSV
    const csvRes = makeRes();
    csvRes.headers = {};
    csvRes.setHeader = (k, v) => (csvRes.headers[k.toLowerCase()] = v);
    csvRes.send = (b) => ((csvRes.body = b), csvRes);
    await reports.getChannelsReport({ headers: {}, workspaceId: "ws1", user: admin(), query: { from: "2026-03-01", to: "2026-03-31", format: "csv" } }, csvRes);
    assert.equal(csvRes.statusCode, 200);
    assert.match(csvRes.headers["content-type"], /text\/csv/);
    assert.match(csvRes.body.split("\r\n")[0], /^channel,label,orders,netMinorUnits/);
    assert.match(csvRes.body, /google,Google,1,40000/);
});

// ── platform tools ──────────────────────────────────────────────────────────
test("deleting a company's data needs a reason and the typed slug, and is audited outside the company", async () => {
    await ingestOrder("ws2", { externalId: "b1", orderedAt: "2026-03-02T00:00:00Z", currency: "USD", grossAmount: 1 });
    const pa = { id: "pa", role: "platform_admin", workspaceId: null };
    let res = await call(platform.deleteCompanyData, { user: pa, params: { workspaceId: "ws2" }, body: { reason: "Customer asked to delete" } });
    assert.equal(res.statusCode, 400);
    res = await call(platform.deleteCompanyData, { user: pa, params: { workspaceId: "ws2" }, body: { reason: "Customer asked to delete", confirm: "beta-2" } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(T.Order.filter((o) => o.workspaceId === "ws2").length, 0);
    assert.equal(T.Workspace.some((w) => w.id === "ws2"), false);
    assert.ok(T.AuditLog.some((a) => a.action === "admin.workspace_deleted" && a.workspaceId === null && a.targetId === "ws2"));
    assert.equal(T.Order.length, 0);
    const health = await call(platform.getPlatformHealth, { user: pa });
    assert.equal(health.statusCode, 200);
    assert.ok("queue" in health.body && "eventsPerMinute" in health.body);
});
