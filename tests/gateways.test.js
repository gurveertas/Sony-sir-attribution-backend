import { mockFetch } from "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";

const stripe = await import("../services/gateways/stripe.js");
const paypal = await import("../services/gateways/paypal.js");
const razorpay = await import("../services/gateways/razorpay.js");
const registry = await import("../services/gateways/index.js");

const KEY = "sk_test_51Abcdefghijklmnop";

test("stripe: rejects malformed keys, accepts sk/rk", () => {
    assert.throws(() => stripe.parseSecretKey("pk_test_123"), /secret key/);
    assert.throws(() => stripe.parseSecretKey(""), /secret key/);
    assert.equal(stripe.parseSecretKey(`  ${KEY} `), KEY);
    assert.equal(stripe.parseSecretKey("rk_live_abcdefghijklmnop"), "rk_live_abcdefghijklmnop");
    assert.equal(stripe.keyEnvironment("sk_live_abcdefghijklmnop"), "live");
    assert.equal(stripe.keyEnvironment(KEY), "test");
});

test("stripe: createWebhook sends form body + bearer key + idempotency key and returns the one-time secret", async () => {
    const f = mockFetch(() => ({ json: { id: "we_123", secret: "whsec_abc", status: "enabled" } }));
    try {
        const hook = await stripe.createWebhook({ secretKey: KEY, url: "https://api.example.com/hook", idempotencyKey: "k1", description: "d" });
        assert.deepEqual(hook, { id: "we_123", secret: "whsec_abc", status: "enabled" });
        const [call] = f.calls;
        assert.equal(call.url, "https://api.stripe.com/v1/webhook_endpoints");
        assert.equal(call.method, "POST");
        assert.equal(call.headers.Authorization, `Bearer ${KEY}`);
        assert.equal(call.headers["Idempotency-Key"], "k1");
        const body = new URLSearchParams(call.body);
        assert.equal(body.get("url"), "https://api.example.com/hook");
        assert.deepEqual(body.getAll("enabled_events[]"), stripe.STRIPE_EVENTS);
    } finally {
        f.restore();
    }
});

test("stripe: 401 -> invalid_credentials without leaking the key; 403 explains restricted-key permissions", async () => {
    let f = mockFetch(() => ({ status: 401, json: { error: { message: `Invalid API Key provided: ${KEY}` } } }));
    try {
        await assert.rejects(stripe.createWebhook({ secretKey: KEY, url: "https://x" }), (err) => {
            assert.equal(err.kind, "invalid_credentials");
            assert.ok(!err.message.includes(KEY));
            return true;
        });
    } finally {
        f.restore();
    }
    f = mockFetch(() => ({ status: 403, json: { error: { message: "permission" } } }));
    try {
        await assert.rejects(stripe.createWebhook({ secretKey: "rk_test_abcdefghijklmnop", url: "https://x" }), /Webhook Endpoints/);
    } finally {
        f.restore();
    }
});

test("stripe: verifyCredentials tolerates restricted keys that cannot read /account", async () => {
    const f = mockFetch(() => ({ status: 403, json: { error: { message: "no" } } }));
    try {
        assert.deepEqual(await stripe.verifyCredentials("rk_test_abcdefghijklmnop"), { accountId: null, businessName: null });
    } finally {
        f.restore();
    }
});

test("stripe: 5xx / network failure -> unavailable", async () => {
    const f = mockFetch(() => ({ status: 503, json: {} }));
    try {
        await assert.rejects(stripe.createWebhook({ secretKey: KEY, url: "https://x" }), (e) => e.kind === "unavailable");
    } finally {
        f.restore();
    }
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("ECONNRESET"); };
    try {
        await assert.rejects(stripe.createWebhook({ secretKey: KEY, url: "https://x" }), (e) => e.kind === "unavailable" && !/ECONNRESET/.test(e.message));
    } finally {
        globalThis.fetch = original;
    }
});

test("stripe: deleteWebhook treats 404 as already gone", async () => {
    const f = mockFetch(() => ({ status: 404, json: { error: { message: "nope" } } }));
    try {
        assert.deepEqual(await stripe.deleteWebhook({ secretKey: KEY, id: "we_1" }), { deleted: false, alreadyGone: true });
    } finally {
        f.restore();
    }
});

const PP = { clientId: "cid", clientSecret: "sec", environment: "sandbox" };

test("paypal: parseCredentials validates", () => {
    assert.throws(() => paypal.parseCredentials({}), /required/);
    assert.throws(() => paypal.parseCredentials({ clientId: "a", clientSecret: "b", environment: "prod" }), /environment/);
    assert.deepEqual(paypal.parseCredentials({ clientId: " a ", clientSecret: "b" }), { clientId: "a", clientSecret: "b", environment: "sandbox" });
});

test("paypal: createWebhook gets a token (cached), then POSTs event_types", async () => {
    paypal.clearTokenCache();
    const f = mockFetch((call) => {
        if (call.url.endsWith("/v1/oauth2/token")) return { json: { access_token: "tok", expires_in: 3000 } };
        return { json: { id: "WH-1" } };
    });
    try {
        assert.deepEqual(await paypal.createWebhook({ creds: PP, url: "https://api.example.com/h" }), { id: "WH-1", reused: false });
        await paypal.createWebhook({ creds: PP, url: "https://api.example.com/h2" });
        const tokenCalls = f.calls.filter((c) => c.url.endsWith("/oauth2/token"));
        assert.equal(tokenCalls.length, 1, "token must be cached");
        const create = f.calls.find((c) => c.url.endsWith("/v1/notifications/webhooks") && c.method === "POST");
        assert.ok(create.url.startsWith("https://api-m.sandbox.paypal.com"));
        assert.deepEqual(JSON.parse(create.body).event_types, paypal.PAYPAL_EVENTS.map((name) => ({ name })));
    } finally {
        f.restore();
    }
});

test("paypal: reuses an existing webhook when the URL is already registered", async () => {
    paypal.clearTokenCache();
    const f = mockFetch((call) => {
        if (call.url.endsWith("/oauth2/token")) return { json: { access_token: "tok", expires_in: 3000 } };
        if (call.method === "POST") return { status: 400, json: { name: "WEBHOOK_URL_ALREADY_EXISTS", message: "exists" } };
        return { json: { webhooks: [{ id: "WH-OLD", url: "https://api.example.com/h" }] } };
    });
    try {
        assert.deepEqual(await paypal.createWebhook({ creds: PP, url: "https://api.example.com/h" }), { id: "WH-OLD", reused: true });
    } finally {
        f.restore();
    }
});

test("paypal: bad credentials -> invalid_credentials", async () => {
    paypal.clearTokenCache();
    const f = mockFetch(() => ({ status: 401, json: { error: "invalid_client" } }));
    try {
        await assert.rejects(paypal.getAccessToken(PP), (e) => e.kind === "invalid_credentials");
    } finally {
        f.restore();
    }
});

test("paypal: verifyWebhookSignature returns true only for SUCCESS and requires all headers", async () => {
    paypal.clearTokenCache();
    const headers = {
        "paypal-auth-algo": "a", "paypal-cert-url": "c", "paypal-transmission-id": "i",
        "paypal-transmission-sig": "s", "paypal-transmission-time": "t",
    };
    let status = "SUCCESS";
    const f = mockFetch((call) => {
        if (call.url.endsWith("/oauth2/token")) return { json: { access_token: "tok", expires_in: 3000 } };
        return { json: { verification_status: status } };
    });
    try {
        assert.equal(await paypal.verifyWebhookSignature({ creds: PP, webhookId: "W", headers, event: {} }), true);
        status = "FAILURE";
        assert.equal(await paypal.verifyWebhookSignature({ creds: PP, webhookId: "W", headers, event: {} }), false);
        await assert.rejects(paypal.verifyWebhookSignature({ creds: PP, webhookId: "W", headers: {}, event: {} }), /missing required signature headers/);
    } finally {
        f.restore();
    }
});

test("razorpay: generates a strong unique secret and setup steps mention URL + events", () => {
    const a = razorpay.generateWebhookSecret();
    assert.match(a, /^[0-9a-f]{48}$/);
    assert.notEqual(a, razorpay.generateWebhookSecret());
    const steps = razorpay.setupSteps({ webhookUrl: "https://api.example.com/h" }).join("\n");
    assert.match(steps, /https:\/\/api\.example\.com\/h/);
    assert.match(steps, /payment\.captured/);
});

test("registry: webhook URL + public-https guard", () => {
    assert.equal(registry.buildWebhookUrl("stripe", "abc"), "https://api.example.com/api/connectors/stripe/webhook/abc");
    assert.doesNotThrow(() => registry.assertPublicHttpsUrl("https://api.example.com"));
    for (const bad of ["http://api.example.com", "https://localhost:5000", "https://192.168.1.5", "https://10.0.0.2", "https://127.0.0.1", "not a url"]) {
        assert.throws(() => registry.assertPublicHttpsUrl(bad), registry.ValidationError, bad);
    }
});

test("driver stripe.connect: stores webhook secret, NOT the api key; fingerprint from account id", async () => {
    const f = mockFetch((call) => {
        if (call.url.endsWith("/v1/account")) return { json: { id: "acct_1", business_profile: { name: "Acme" } } };
        return { json: { id: "we_9", secret: "whsec_zzz", status: "enabled" } };
    });
    try {
        const out = await registry.drivers.stripe.connect({
            creds: { secretKey: KEY }, webhookUrl: "https://api.example.com/h", connectorId: "c1", name: "Stripe",
        });
        assert.deepEqual(out.secrets, { webhookSecret: "whsec_zzz" });
        assert.equal(out.publicConfig.webhookEndpointId, "we_9");
        assert.equal(out.publicConfig.stripeAccountId, "acct_1");
        assert.equal(out.publicConfig.environment, "test");
        assert.ok(out.fingerprint);
        assert.ok(!JSON.stringify(out).includes(KEY), "api key must not appear anywhere in the result");
    } finally {
        f.restore();
    }
});

test("driver stripe.removeRemote: without credentials it reports manual cleanup instead of failing", async () => {
    const r = await registry.drivers.stripe.removeRemote({ config: { webhookEndpointId: "we_1" }, creds: null });
    assert.deepEqual(r, { removed: false, reason: "credentials_not_provided" });
});

test("driver razorpay.connect: manual mode reveals URL + secret once, stores secret", async () => {
    const out = await registry.drivers.razorpay.connect({ webhookUrl: "https://api.example.com/h" });
    assert.equal(out.reveal.webhookSecret, out.secrets.webhookSecret);
    assert.deepEqual(out.reveal.events, razorpay.RAZORPAY_EVENTS);
    assert.equal(out.remoteRef, null);
    assert.equal(registry.drivers.razorpay.mode, "manual");
});
