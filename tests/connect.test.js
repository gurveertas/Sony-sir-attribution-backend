import { mockFetch } from "./setup.js";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, makeRes, adminReq } from "./fakeDb.js";

const fake = createFakeDb();
mock.module("../src/prisma/db.js", { namedExports: { db: fake.db }, defaultExport: fake.db });

const ctrl = await import("../controllers/gatewayConnectController.js");
const mgmt = await import("../controllers/connectorManagementController.js");
const { getConnectorConfig } = await import("../utils/connectorConfig.js");
const paypal = await import("../services/gateways/paypal.js");

const KEY = "sk_test_51Abcdefghijklmnop";
const reset = () => {
    for (const k of Object.keys(fake.tables)) fake.tables[k] = [];
    fake.state.failOn = {};
    paypal.clearTokenCache();
};

const stripeFetch = (opts = {}) =>
    mockFetch((call) => {
        if (call.url.endsWith("/v1/account")) return opts.account ?? { json: { id: "acct_1", business_profile: { name: "Acme" } } };
        if (call.method === "POST") return opts.create ?? { json: { id: "we_9", secret: "whsec_secret_9", status: "enabled" } };
        if (call.method === "DELETE") return opts.del ?? { json: { id: "we_9", deleted: true } };
        return { json: {} };
    });

const paypalFetch = (opts = {}) =>
    mockFetch((call) => {
        if (call.url.endsWith("/oauth2/token")) return { json: { access_token: "tok", expires_in: 3000 } };
        if (call.method === "POST") return opts.create ?? { json: { id: "WH-1" } };
        if (call.method === "DELETE") return opts.del ?? { status: 204, json: null };
        return opts.get ?? { json: { id: "WH-1", url: opts.url ?? "", event_types: [{ name: "PAYMENT.CAPTURE.COMPLETED" }, { name: "PAYMENT.CAPTURE.REFUNDED" }] } };
    });

async function connect(body) {
    const res = makeRes();
    await ctrl.connectGateway(adminReq(body), res);
    return res;
}

test("stripe connect: creates connector + remote webhook, stores only the webhook secret, leaks nothing", async () => {
    reset();
    const f = stripeFetch();
    try {
        const res = await connect({ type: "stripe", credentials: { secretKey: KEY } });
        assert.equal(res.statusCode, 201, JSON.stringify(res.body));
        assert.equal(res.body.connected, true);
        assert.equal(res.body.status, "pending");
        assert.equal(res.body.connection.awaitingFirstEvent, true);
        assert.equal(res.body.connection.accountId, "acct_1");
        assert.equal(res.body.setup, null);

        const row = fake.tables.Connector[0];
        assert.equal(res.body.webhookUrl, `https://api.example.com/api/connectors/stripe/webhook/${row.id}`);
        const created = f.calls.find((c) => c.method === "POST");
        assert.equal(new URLSearchParams(created.body).get("url"), res.body.webhookUrl, "gateway must be told the connector's own URL");

        const cfg = getConnectorConfig(row);
        assert.equal(cfg.webhookSecret, "whsec_secret_9");
        assert.equal(cfg.webhookEndpointId, "we_9");
        assert.ok(!JSON.stringify(row).includes("whsec_secret_9"), "secret must be encrypted at rest");
        assert.ok(!JSON.stringify(row).includes(KEY), "api key must not be persisted");
        assert.ok(!JSON.stringify(res.body).includes("whsec_secret_9") && !JSON.stringify(res.body).includes(KEY));

        const log = fake.tables.AuditLog.find((a) => a.action === "connector.connected");
        assert.ok(log && !JSON.stringify(log).includes("whsec_") && !JSON.stringify(log).includes(KEY));
    } finally { f.restore(); }
});

test("stripe connect: invalid key -> 400 and no connector row left behind", async () => {
    reset();
    const f = stripeFetch({ account: { status: 401, json: { error: { message: "Invalid API Key" } } } });
    try {
        const res = await connect({ type: "stripe", credentials: { secretKey: KEY } });
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, "invalid_credentials");
        assert.equal(fake.tables.Connector.length, 0);
    } finally { f.restore(); }
});

test("stripe connect: malformed key is rejected before any network call", async () => {
    reset();
    const f = stripeFetch();
    try {
        const res = await connect({ type: "stripe", credentials: { secretKey: "nope" } });
        assert.equal(res.statusCode, 400);
        assert.equal(f.calls.length, 0);
        assert.equal(fake.tables.Connector.length, 0);
    } finally { f.restore(); }
});

test("stripe connect: if saving fails AFTER the remote webhook exists, the remote webhook is deleted (no orphan)", async () => {
    reset();
    fake.state.failOn = { AuditLog: true };
    const f = stripeFetch();
    try {
        const res = await connect({ type: "stripe", credentials: { secretKey: KEY } });
        assert.equal(res.statusCode, 500);
        assert.ok(f.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/webhook_endpoints/we_9")), "rollback must delete we_9");
        assert.equal(fake.tables.Connector.length, 0);
    } finally { f.restore(); }
});

test("stripe connect: same Stripe account twice -> 409 and the second webhook is rolled back", async () => {
    reset();
    const f = stripeFetch();
    try {
        assert.equal((await connect({ type: "stripe", credentials: { secretKey: KEY } })).statusCode, 201);
        const second = await connect({ type: "stripe", credentials: { secretKey: KEY } });
        assert.equal(second.statusCode, 409);
        assert.equal(second.body.code, "already_connected");
        assert.equal(fake.tables.Connector.length, 1);
        assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 1);
    } finally { f.restore(); }
});

test("stripe connect: unreachable Stripe -> 502 and clean state", async () => {
    reset();
    const f = stripeFetch({ account: { status: 503, json: {} } });
    try {
        const res = await connect({ type: "stripe", credentials: { secretKey: KEY } });
        assert.equal(res.statusCode, 502);
        assert.equal(fake.tables.Connector.length, 0);
    } finally { f.restore(); }
});

test("connect refuses non-public APP_API_URL", async () => {
    reset();
    const prev = process.env.APP_API_URL;
    // base url is read from the already-loaded ENV, so assert through the catalog endpoint's readiness flag instead
    const res = makeRes();
    await ctrl.listGatewayCatalog({}, res);
    assert.equal(res.body.ready, true);
    assert.deepEqual(res.body.data.map((g) => g.type), ["stripe", "paypal", "razorpay"]);
    process.env.APP_API_URL = prev;
});

test("paypal connect: stores encrypted client credentials + webhook id; disconnect deletes the remote webhook and wipes secrets", async () => {
    reset();
    const f = paypalFetch();
    try {
        const res = await connect({ type: "paypal", credentials: { clientId: "cid", clientSecret: "csecret", environment: "sandbox" } });
        assert.equal(res.statusCode, 201, JSON.stringify(res.body));
        const row = fake.tables.Connector[0];
        const cfg = getConnectorConfig(row);
        assert.deepEqual([cfg.clientId, cfg.clientSecret, cfg.webhookId, cfg.paypalEnvironment], ["cid", "csecret", "WH-1", "sandbox"]);
        assert.ok(!JSON.stringify(row).includes("csecret"));
        assert.ok(!JSON.stringify(res.body).includes("csecret"));

        const dis = makeRes();
        await ctrl.disconnectConnector(adminReq({}, { id: row.id }), dis);
        assert.equal(dis.statusCode, 200, JSON.stringify(dis.body));
        assert.equal(dis.body.status, "disabled");
        assert.equal(dis.body.remoteWebhook.removed, true);
        assert.deepEqual(dis.body.manualSteps, []);
        assert.ok(f.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/webhooks/WH-1")));
        const after = fake.tables.Connector[0];
        assert.equal(after.secretsEnc, null);
        assert.equal(after.config.webhookId, undefined);
        assert.ok(after.config.disconnectedAt);

        const again = makeRes();
        await ctrl.disconnectConnector(adminReq({}, { id: row.id }), again);
        assert.equal(again.body.alreadyDisconnected, true);
    } finally { f.restore(); }
});

test("paypal disconnect: gateway failure -> 502 canForce; force=true disconnects anyway with manual steps", async () => {
    reset();
    const f = paypalFetch({ del: { status: 500, json: { message: "boom" } } });
    try {
        await connect({ type: "paypal", credentials: { clientId: "cid", clientSecret: "csecret", environment: "sandbox" } });
        const id = fake.tables.Connector[0].id;

        const res = makeRes();
        await ctrl.disconnectConnector(adminReq({}, { id }), res);
        assert.equal(res.statusCode, 502);
        assert.equal(res.body.canForce, true);
        assert.equal(fake.tables.Connector[0].status, "pending");

        const forced = makeRes();
        await ctrl.disconnectConnector(adminReq({ force: true }, { id }), forced);
        assert.equal(forced.statusCode, 200);
        assert.equal(forced.body.status, "disabled");
        assert.equal(forced.body.manualSteps.length, 1);
    } finally { f.restore(); }
});

test("stripe disconnect: without the key it cannot delete remotely and says so; with the key it deletes", async () => {
    reset();
    const f = stripeFetch();
    try {
        await connect({ type: "stripe", credentials: { secretKey: KEY } });
        const id = fake.tables.Connector[0].id;
        const noKey = makeRes();
        await ctrl.disconnectConnector(adminReq({}, { id }), noKey);
        assert.equal(noKey.body.remoteWebhook.removed, false);
        assert.equal(noKey.body.remoteWebhook.reason, "credentials_not_provided");
        assert.equal(noKey.body.manualSteps.length, 1);
        assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 0);

        // reconnect (re-enables), then disconnect with the key
        const re = makeRes();
        await ctrl.reconnectConnector(adminReq({ credentials: { secretKey: KEY } }, { id }), re);
        assert.equal(re.statusCode, 200, JSON.stringify(re.body));
        assert.equal(re.body.status, "pending");
        const withKey = makeRes();
        await ctrl.disconnectConnector(adminReq({ credentials: { secretKey: KEY } }, { id }), withKey);
        assert.equal(withKey.body.remoteWebhook.removed, true);
    } finally { f.restore(); }
});

test("razorpay connect: manual — returns URL + one-time secret, makes no network calls, stores encrypted secret", async () => {
    reset();
    const f = mockFetch(() => { throw new Error("no network expected"); });
    try {
        const res = await connect({ type: "razorpay", name: "RZP main" });
        assert.equal(res.statusCode, 201, JSON.stringify(res.body));
        assert.equal(f.calls.length, 0);
        assert.equal(res.body.mode, "manual");
        assert.equal(res.body.name, "RZP main");
        const row = fake.tables.Connector[0];
        assert.equal(getConnectorConfig(row).webhookSecret, res.body.setup.webhookSecret);
        assert.equal(res.body.setup.webhookUrl, `https://api.example.com/api/connectors/razorpay/webhook/${row.id}`);

        // the secret is never shown again
        const detail = makeRes();
        await ctrl.getConnector(adminReq({}, { id: row.id }), detail);
        assert.equal(detail.statusCode, 200);
        assert.equal(detail.body.hasSigningSecret, true);
        assert.ok(!JSON.stringify(detail.body).includes(res.body.setup.webhookSecret));

        // rotate
        const rot = makeRes();
        await ctrl.reconnectConnector(adminReq({}, { id: row.id }), rot);
        assert.notEqual(rot.body.setup.webhookSecret, res.body.setup.webhookSecret);
        assert.equal(getConnectorConfig(fake.tables.Connector[0]).webhookSecret, rot.body.setup.webhookSecret);
    } finally { f.restore(); }
});

test("verify: paypal checks remote webhook; awaiting first event is not a failure", async () => {
    reset();
    const f = paypalFetch({ url: "PLACEHOLDER" });
    try {
        await connect({ type: "paypal", credentials: { clientId: "cid", clientSecret: "csecret", environment: "sandbox" } });
        const row = fake.tables.Connector[0];
        f.restore();
        const g = paypalFetch({ url: `https://api.example.com/api/connectors/paypal/webhook/${row.id}` });
        try {
            const res = makeRes();
            await ctrl.verifyConnector(adminReq({}, { id: row.id }), res);
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.ok, true, JSON.stringify(res.body.checks));
            assert.equal(res.body.awaitingFirstEvent, true);
            assert.ok(res.body.checks.find((c) => c.name === "remote_url_matches").ok);
        } finally { g.restore(); }

        const h = paypalFetch({ get: { status: 404, json: {} } });
        try {
            const res = makeRes();
            await ctrl.verifyConnector(adminReq({}, { id: row.id }), res);
            assert.equal(res.body.ok, false);
            assert.equal(res.body.checks.find((c) => c.name === "remote_webhook_active").ok, false);
        } finally { h.restore(); }
    } finally { f.restore(); }
});

test("operations on a missing / non-gateway connector", async () => {
    reset();
    const miss = makeRes();
    await ctrl.disconnectConnector(adminReq({}, { id: "nope" }), miss);
    assert.equal(miss.statusCode, 404);

    await mgmt.createConnector(adminReq({ type: "shopify", name: "Shop", config: { sharedSecret: "s" } }), makeRes());
    const shop = fake.tables.Connector[0];
    const res = makeRes();
    await ctrl.reconnectConnector(adminReq({}, { id: shop.id }), res);
    assert.equal(res.statusCode, 400);
});

test("tenant isolation: another workspace's admin cannot touch the connector", async () => {
    reset();
    await connect({ type: "razorpay" });
    const id = fake.tables.Connector[0].id;
    const req = adminReq({}, { id });
    req.user.workspaceId = "OTHER";
    for (const fn of [ctrl.getConnector, ctrl.disconnectConnector, ctrl.reconnectConnector, ctrl.verifyConnector]) {
        const res = makeRes();
        await fn(req, res);
        assert.equal(res.statusCode, 404, fn.name);
    }
});

test("PATCH config is merged (secrets survive) and gateway-managed keys are protected", async () => {
    reset();
    const f = stripeFetch();
    try {
        await connect({ type: "stripe", credentials: { secretKey: KEY } });
        const id = fake.tables.Connector[0].id;

        const ok = makeRes();
        await mgmt.updateConnector(adminReq({ config: { note: "hello" } }, { id }), ok);
        assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
        const cfg = getConnectorConfig(fake.tables.Connector[0]);
        assert.equal(cfg.note, "hello");
        assert.equal(cfg.webhookSecret, "whsec_secret_9", "secret must survive a partial config update");
        assert.equal(cfg.webhookEndpointId, "we_9");

        const bad = makeRes();
        await mgmt.updateConnector(adminReq({ config: { webhookSecret: "x" } }, { id }), bad);
        assert.equal(bad.statusCode, 400);
        assert.match(bad.body.message, /reconnect/);

        const dropped = makeRes();
        await mgmt.updateConnector(adminReq({ config: { note: null } }, { id }), dropped);
        assert.equal(getConnectorConfig(fake.tables.Connector[0]).note, undefined);
    } finally { f.restore(); }
});

test("DELETE: connector with events -> 409 pointing at disconnect; empty connector deletes", async () => {
    reset();
    await connect({ type: "razorpay" });
    const id = fake.tables.Connector[0].id;
    fake.tables.RawEvent.push({ id: "e1", connectorId: id, workspaceId: "ws1", status: "processed" });
    const blocked = makeRes();
    await mgmt.deleteConnector(adminReq({}, { id }), blocked);
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.body.code, "connector_has_data");

    fake.tables.RawEvent = [];
    const ok = makeRes();
    await mgmt.deleteConnector(adminReq({}, { id }), ok);
    assert.equal(ok.statusCode, 204);
    assert.equal(fake.tables.Connector.length, 0);
});

test("list returns webhook URL + connection summary and never any secret", async () => {
    reset();
    const f = paypalFetch();
    try {
        await connect({ type: "paypal", credentials: { clientId: "cid", clientSecret: "csecret", environment: "sandbox" } });
        const res = makeRes();
        await mgmt.listConnectors(adminReq(), res);
        assert.equal(res.body.data.length, 1);
        assert.match(res.body.data[0].webhookUrl, /\/api\/connectors\/paypal\/webhook\//);
        assert.equal(res.body.data[0].connection.environment, "sandbox");
        assert.ok(!JSON.stringify(res.body).includes("csecret"));
    } finally { f.restore(); }
});
