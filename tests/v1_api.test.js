import "./setup.js";
import test, { mock, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { createFakeDb } from "./fakeDb.js";

const fake = createFakeDb();
mock.module("../src/prisma/db.js", { namedExports: { db: fake.db }, defaultExport: fake.db });

// Cookie-session auth is not what is under test: stand in for it with a header.
mock.module("../middlewares/protectRoute.js", {
    namedExports: {
        protectRoute: (req, res, next) => {
            const raw = req.headers["x-test-user"];
            if (!raw) return res.status(401).json({ message: "Not logged in" });
            req.user = JSON.parse(raw);
            req.workspaceId = req.user.workspaceId ?? null;
            return next();
        },
        requireRole: (...roles) => (req, res, next) =>
            roles.includes(req.user?.role) ? next() : res.status(403).json({ message: "You do not have permission for this action" }),
    },
});

const v1Routes = (await import("../routes/v1Routes.js")).default;
const app = express();
app.use(express.json());
app.use("/v1", v1Routes);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const T = fake.tables;
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const KEYS = { secret1: "wk_secret_ws1_aaaaaaaaaaaaaaaa", pub1: "wk_live_ws1_pubpubpubpubpubpub", secret2: "wk_secret_ws2_bbbbbbbbbbbbbbbb", revoked: "wk_secret_revoked_cccccccccccc", limited: "wk_secret_limited_dddddddddddd", suspended: "wk_secret_suspended_eeeeeeeeee" };
const ORIGIN = "https://shop.example.com";

T.ApiKey = [
    { id: "k1", keyHash: sha(KEYS.secret1), type: "secret", mode: "live", workspaceId: "ws1", allowedOrigins: [], revokedAt: null, expiresAt: null, siteId: null, rateLimitPerMin: 1000 },
    { id: "k2", keyHash: sha(KEYS.pub1), type: "publishable", mode: "live", workspaceId: "ws1", allowedOrigins: [ORIGIN], revokedAt: null, expiresAt: null, siteId: null, rateLimitPerMin: 1000 },
    { id: "k3", keyHash: sha(KEYS.secret2), type: "secret", mode: "live", workspaceId: "ws2", allowedOrigins: [], revokedAt: null, expiresAt: null, siteId: null, rateLimitPerMin: 1000 },
    { id: "k4", keyHash: sha(KEYS.revoked), type: "secret", mode: "live", workspaceId: "ws1", allowedOrigins: [], revokedAt: "2026-01-01T00:00:00Z", expiresAt: null, siteId: null, rateLimitPerMin: 1000 },
    { id: "k6", keyHash: sha(KEYS.suspended), type: "secret", mode: "live", workspaceId: "ws3", allowedOrigins: [], revokedAt: null, expiresAt: null, siteId: null, rateLimitPerMin: 1000 },
    { id: "k5", keyHash: sha(KEYS.limited), type: "secret", mode: "live", workspaceId: "ws1", allowedOrigins: [], revokedAt: null, expiresAt: null, siteId: null, rateLimitPerMin: 3 },
];
// live keys only work once the company has a verified domain (scope 4.1)
T.Site = [
    { id: "s1", workspaceId: "ws1", domain: "shop.example.com", verifiedAt: "2026-01-01T00:00:00Z" },
    { id: "s2", workspaceId: "ws2", domain: "two.example.com", verifiedAt: "2026-01-01T00:00:00Z" },
    { id: "s3", workspaceId: "ws3", domain: "three.example.com", verifiedAt: "2026-01-01T00:00:00Z" },
];
T.Workspace = [{ id: "ws1", timezone: "Asia/Kolkata", status: "active" }, { id: "ws2", timezone: "UTC", status: "active" }, { id: "ws3", timezone: "UTC", status: "suspended" }];
const o = (id, ws, at, net) => ({ id, workspaceId: ws, status: "paid", orderedAt: at, netMinorUnits: net, isNewCustomer: true });
T.Order = [
    o("o1", "ws1", "2026-03-01T18:29:59.000Z", 1000n),   // Mar 1 23:59:59 IST
    o("o2", "ws1", "2026-03-01T18:30:00.000Z", 2000n),   // Mar 2 00:00:00 IST
    o("o3", "ws2", "2026-03-02T10:00:00.000Z", 999999n), // another company
];

const get = (path, headers = {}) => fetch(base + path, { headers });
const send = (method, path, body, headers = {}) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
const bearer = (k) => ({ authorization: `Bearer ${k}` });

test("READ with a SECRET key: works (Bearer and X-Api-Key), scoped to the key's company, uses the company's local days", async () => {
    for (const headers of [bearer(KEYS.secret1), { "x-api-key": KEYS.secret1 }]) {
        const res = await get("/v1/reports/trend?from=2026-03-01&to=2026-03-02", headers);
        assert.equal(res.status, 200, await res.clone().text());
        const body = await res.json();
        assert.equal(body.tz, "Asia/Kolkata");
        assert.deepEqual(body.data.map((d) => [d.date, d.netMinorUnits]), [["2026-03-01", "1000"], ["2026-03-02", "2000"]]);
        assert.ok(!JSON.stringify(body).includes("999999"), "other company's revenue must never appear");
    }
    const other = await (await get("/v1/reports/trend?from=2026-03-02&to=2026-03-02", bearer(KEYS.secret2))).json();
    assert.deepEqual(other.data.map((d) => [d.date, d.netMinorUnits]), [["2026-03-02", "999999"]]);
});

test("READ with a PUBLISHABLE key is refused (it is public); revoked / unknown keys are 401; no credentials is 401", async () => {
    const pub = await get("/v1/reports/summary", { ...bearer(KEYS.pub1), origin: ORIGIN });
    assert.equal(pub.status, 403);
    assert.match((await pub.json()).message, /key type cannot call this route/);
    assert.equal((await get("/v1/reports/summary", bearer(KEYS.revoked))).status, 401);
    assert.equal((await get("/v1/reports/summary", bearer("wk_secret_unknown"))).status, 401);
    assert.equal((await get("/v1/reports/summary")).status, 401);
});

test("READ with a dashboard session still works with role checks (cookie path unchanged)", async () => {
    const viewer = JSON.stringify({ id: "u1", role: "company_viewer", workspaceId: "ws1" });
    const ok = await get("/v1/reports/trend?from=2026-03-01&to=2026-03-02", { "x-test-user": viewer });
    assert.equal(ok.status, 200);
    const nobody = await get("/v1/reports/trend", { "x-test-user": JSON.stringify({ id: "u2", role: "intruder", workspaceId: "ws1" }) });
    assert.equal(nobody.status, 403);
});

test("dashboard overview accepts a secret key (workspace comes from the key, not 'Workspace id required')", async () => {
    const res = await get("/v1/reports/dashboard?from=2026-03-01&to=2026-03-02", bearer(KEYS.secret1));
    assert.notEqual(res.status, 401, await res.clone().text());
    assert.notEqual(res.status, 403);
});

test("REFUNDS and record edits require a SECRET key; a publishable key is rejected even from an allowed origin", async () => {
    const pub = { ...bearer(KEYS.pub1), origin: ORIGIN };
    for (const [method, path, body] of [
        ["POST", "/v1/refunds", { externalOrderId: "o1", amount: 5, currency: "USD" }],
        ["PATCH", "/v1/orders/o1", { status: "refunded" }],
        ["PATCH", "/v1/bookings/b1", { status: "cancelled" }],
    ]) {
        const res = await send(method, path, body, pub);
        assert.equal(res.status, 403, `${method} ${path}`);
        assert.match((await res.json()).message, /key type cannot call this route/);
    }
    // a secret key gets past authentication and reaches the controller (which then says the order doesn't exist)
    const withSecret = await send("POST", "/v1/refunds", { externalOrderId: "missing", amount: 5, currency: "USD" }, bearer(KEYS.secret1));
    assert.equal(withSecret.status, 404);
    assert.equal((await withSecret.json()).message, "Order not found");
});

test("ORDER/BOOKING ingestion still accepts a publishable key from an allowed origin (and rejects other origins)", async () => {
    const good = await send("POST", "/v1/orders", {}, { ...bearer(KEYS.pub1), origin: ORIGIN });
    assert.equal(good.status, 400); // authenticated; rejected by validation
    assert.match((await good.json()).message, /externalId is required/);
    const wrongOrigin = await send("POST", "/v1/orders", {}, { ...bearer(KEYS.pub1), origin: "https://evil.example" });
    assert.equal(wrongOrigin.status, 403);
    assert.match((await wrongOrigin.json()).message, /Origin not allowed/);
});

test("rate limiting: headers on every keyed response, 429 + Retry-After beyond the key's per-minute limit", async () => {
    const statuses = [];
    let last;
    for (let i = 0; i < 4; i++) {
        last = await get("/v1/reports/trend", bearer(KEYS.limited));
        statuses.push(last.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    assert.equal(last.headers.get("x-ratelimit-limit"), "3");
    assert.equal(last.headers.get("x-ratelimit-remaining"), "0");
    assert.ok(last.headers.get("retry-after"));
});

test("a SUSPENDED company's API keys stop working immediately (same rule the login already has)", async () => {
    const res = await get("/v1/reports/summary", bearer(KEYS.suspended));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).message, "Workspace is not active");
});

test("order and booking LIST filters use the company's local days, so drill-downs add up to the report", async () => {
    T.Order = [
        { id: "a", workspaceId: "ws1", status: "paid", orderedAt: "2026-03-01T18:29:59.000Z", netMinorUnits: 1n, isNewCustomer: true },
        { id: "b", workspaceId: "ws1", status: "paid", orderedAt: "2026-03-01T18:30:00.000Z", netMinorUnits: 1n, isNewCustomer: true },
        { id: "c", workspaceId: "ws1", status: "paid", orderedAt: "2026-03-02T18:29:59.000Z", netMinorUnits: 1n, isNewCustomer: true },
        { id: "d", workspaceId: "ws1", status: "paid", orderedAt: "2026-03-02T18:30:00.000Z", netMinorUnits: 1n, isNewCustomer: true },
    ];
    // Kolkata: "2026-03-02" is exactly b and c (to= must include the WHOLE last day, not stop at its midnight)
    const trend = await (await get("/v1/reports/trend?from=2026-03-02&to=2026-03-02", bearer(KEYS.secret1))).json();
    assert.equal(trend.data[0].orders, 2);
    const bad = await get("/v1/orders?from=nonsense", bearer(KEYS.secret1));
    assert.equal(bad.status, 400);
});
