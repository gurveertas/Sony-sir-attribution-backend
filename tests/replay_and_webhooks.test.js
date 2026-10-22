import "./setup.js";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createFakeDb, makeRes, adminReq } from "./fakeDb.js";

const fake = createFakeDb();
mock.module("../src/prisma/db.js", { namedExports: { db: fake.db }, defaultExport: fake.db });

// Control the processor: replay + webhook flow are what is under test here, not the field mapping.
let processorBehaviour = async () => ({ order: { id: "o1" } });
const processorCalls = [];
mock.module("../services/connectorProcessors.js", {
    namedExports: {
        isReplayable: (t) => ["stripe", "razorpay", "paypal", "shopify", "zenoti", "generic"].includes(t),
        processConnectorEvent: async (args) => {
            processorCalls.push(args);
            return processorBehaviour(args);
        },
    },
});

const mgmt = await import("../controllers/connectorManagementController.js");
const hooks = await import("../controllers/connectorController.js");
const { prepareConnectorConfig } = await import("../utils/connectorConfig.js");

const reset = () => {
    for (const k of Object.keys(fake.tables)) fake.tables[k] = [];
    processorCalls.length = 0;
    processorBehaviour = async () => ({ order: { id: "o1" } });
    fake.tables.Workspace = [{ id: "ws1", status: "active" }];
};
const tick = () => new Promise((r) => setImmediate(r));

async function seedConnector(type = "razorpay", extra = {}) {
    const row = await fake.db.orm.public.Connector.create({
        workspaceId: "ws1", type, name: type, publicId: "conn_x", status: "pending",
        ...prepareConnectorConfig({ webhookSecret: "whsec", gateway: type }), ...extra,
    });
    return row;
}
const seedEvent = (connectorId, over = {}) =>
    fake.db.orm.public.RawEvent.create({ workspaceId: "ws1", connectorId, source: "razorpay", eventType: "payment.captured", payload: { a: 1 }, status: "failed", ...over });

test("replay: failed event is re-run through the processor with its stored type + payload, then marked processed", async () => {
    reset();
    const c = await seedConnector();
    const e = await seedEvent(c.id, { error: "old", replayCount: 1 });
    const res = makeRes();
    await mgmt.replayEvent(adminReq({}, { id: c.id, eventId: e.id }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "processed");
    assert.equal(res.body.replayCount, 2);
    assert.deepEqual([processorCalls[0].eventType, processorCalls[0].payload], ["payment.captured", { a: 1 }]);
    const row = fake.tables.RawEvent[0];
    assert.equal(row.status, "processed");
    assert.equal(row.error, null);
    await tick();
    assert.equal(fake.tables.Connector[0].status, "healthy");
    assert.ok(fake.tables.AuditLog.some((a) => a.action === "connector.event_replayed"));
});

test("replay: still failing -> 422 and stays failed; after MAX attempts it is parked as dead and needs force", async () => {
    reset();
    processorBehaviour = async () => { throw new Error("Order not found"); };
    const c = await seedConnector();
    const e = await seedEvent(c.id, { replayCount: 3 });

    let res = makeRes();
    await mgmt.replayEvent(adminReq({}, { id: c.id, eventId: e.id }), res);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.status, "failed");
    assert.equal(res.body.error, "Order not found");

    res = makeRes();
    await mgmt.replayEvent(adminReq({}, { id: c.id, eventId: e.id }), res); // 5th attempt
    assert.equal(res.body.status, "dead");

    res = makeRes();
    await mgmt.replayEvent(adminReq({}, { id: c.id, eventId: e.id }), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /force/);

    processorBehaviour = async () => ({ order: {} });
    res = makeRes();
    await mgmt.replayEvent(adminReq({ force: true }, { id: c.id, eventId: e.id }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(fake.tables.RawEvent[0].status, "processed");
});

test("replay: processed events, disabled connectors and unknown events are refused", async () => {
    reset();
    const c = await seedConnector();
    const done = await seedEvent(c.id, { status: "processed" });
    let res = makeRes();
    await mgmt.replayEvent(adminReq({}, { id: c.id, eventId: done.id }), res);
    assert.equal(res.statusCode, 400);

    res = makeRes();
    await mgmt.replayEvent(adminReq({}, { id: c.id, eventId: "missing" }), res);
    assert.equal(res.statusCode, 404);

    await fake.db.orm.public.Connector.where({ id: c.id }).update({ status: "disabled" });
    const failed = await seedEvent(c.id);
    res = makeRes();
    await mgmt.replayEvent(adminReq({}, { id: c.id, eventId: failed.id }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(processorCalls.length, 0);
});

test("bulk replay: oldest-first, only failed events, summarised", async () => {
    reset();
    const c = await seedConnector();
    const first = await seedEvent(c.id, { eventType: "payment.captured" });
    const second = await seedEvent(c.id, { eventType: "refund.processed" });
    await seedEvent(c.id, { status: "processed", eventType: "ignored" });
    processorBehaviour = async ({ eventType }) => {
        if (eventType === "refund.processed") throw new Error("still broken");
        return {};
    };
    const res = makeRes();
    await mgmt.replayFailedEvents(adminReq({}, { id: c.id }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual([res.body.attempted, res.body.processed, res.body.stillFailing, res.body.dead], [2, 1, 1, 0]);
    assert.deepEqual(processorCalls.map((p) => p.eventType), ["payment.captured", "refund.processed"], "order must be replayed before its refund");
    assert.equal(fake.tables.RawEvent.find((e) => e.id === first.id).status, "processed");
    assert.equal(fake.tables.RawEvent.find((e) => e.id === second.id).status, "failed");
});

test("event detail returns the payload; list never does", async () => {
    reset();
    const c = await seedConnector();
    const e = await seedEvent(c.id);
    const res = makeRes();
    await mgmt.getConnectorEvent(adminReq({}, { id: c.id, eventId: e.id }), res);
    assert.deepEqual(res.body.payload, { a: 1 });
});

// ── live webhook handler flow ────────────────────────────────────────────────

const stripeSigned = (body, secret) => {
    const ts = Math.floor(Date.now() / 1000);
    return `t=${ts},v1=${crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
};
const webhookReq = (connectorId, body, headers, viaParam = true) => ({
    params: viaParam ? { connectorId } : {}, query: viaParam ? {} : { connectorId },
    headers, rawBody: body, body: JSON.parse(body), ip: "9.9.9.9",
});

test("stripe webhook: valid signature -> raw event saved, processed, connector turns healthy (path + query id both work)", async () => {
    reset();
    const c = await seedConnector("stripe");
    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } });
    for (const viaParam of [true, false]) {
        const res = makeRes();
        await hooks.stripeWebhook(webhookReq(c.id, body, { "stripe-signature": stripeSigned(body, "whsec") }, viaParam), res);
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(res.body.received, true);
    }
    await tick();
    assert.equal(fake.tables.RawEvent.length, 2);
    assert.ok(fake.tables.RawEvent.every((e) => e.status === "processed" && e.eventType === "payment_intent.succeeded"));
    assert.equal(fake.tables.Connector[0].status, "healthy");
    assert.ok(fake.tables.Connector[0].lastEventAt);
});

test("stripe webhook: bad signature -> 400, nothing stored", async () => {
    reset();
    const c = await seedConnector("stripe");
    const body = JSON.stringify({ type: "payment_intent.succeeded", data: { object: {} } });
    const res = makeRes();
    await hooks.stripeWebhook(webhookReq(c.id, body, { "stripe-signature": stripeSigned(body, "WRONG") }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(fake.tables.RawEvent.length, 0);
    assert.equal(processorCalls.length, 0);
});

test("stripe webhook: processing failure -> 500, raw event kept as failed (replayable), connector failing with error count", async () => {
    reset();
    processorBehaviour = async () => { throw new Error("db down"); };
    const c = await seedConnector("stripe");
    const body = JSON.stringify({ id: "evt_2", type: "payment_intent.succeeded", data: { object: {} } });
    const res = makeRes();
    await hooks.stripeWebhook(webhookReq(c.id, body, { "stripe-signature": stripeSigned(body, "whsec") }), res);
    assert.equal(res.statusCode, 500);
    await tick();
    assert.equal(fake.tables.RawEvent[0].status, "failed");
    assert.equal(fake.tables.RawEvent[0].error, "db down");
    assert.deepEqual([fake.tables.Connector[0].status, fake.tables.Connector[0].errorCount, fake.tables.Connector[0].lastError], ["failing", 1, "db down"]);
});

test("a failing connector recovers to healthy after the next good event", async () => {
    reset();
    const c = await seedConnector("stripe", { status: "failing", errorCount: 3 });
    const body = JSON.stringify({ id: "evt_3", type: "payment_intent.succeeded", data: { object: {} } });
    const res = makeRes();
    await hooks.stripeWebhook(webhookReq(c.id, body, { "stripe-signature": stripeSigned(body, "whsec") }), res);
    await tick();
    assert.equal(fake.tables.Connector[0].status, "healthy");
});

test("disabled connector: event acknowledged (200) but ignored — no storage, no processing, no gateway retry storm", async () => {
    reset();
    const c = await seedConnector("stripe", { status: "disabled" });
    const body = JSON.stringify({ type: "payment_intent.succeeded", data: { object: {} } });
    const res = makeRes();
    await hooks.stripeWebhook(webhookReq(c.id, body, { "stripe-signature": "irrelevant" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ignored, "connector_disabled");
    assert.equal(fake.tables.RawEvent.length, 0);
    assert.equal(processorCalls.length, 0);
});

test("webhook for the wrong connector type / unknown id", async () => {
    reset();
    const c = await seedConnector("razorpay");
    const body = JSON.stringify({ type: "x" });
    let res = makeRes();
    await hooks.stripeWebhook(webhookReq(c.id, body, {}), res);
    assert.equal(res.statusCode, 400);
    res = makeRes();
    await hooks.stripeWebhook(webhookReq("does-not-exist", body, {}), res);
    assert.equal(res.statusCode, 404);
    res = makeRes();
    await hooks.stripeWebhook({ params: {}, query: {}, headers: {}, body: {} }, res);
    assert.equal(res.statusCode, 400);
});

test("razorpay webhook: HMAC verified with the stored secret", async () => {
    reset();
    const c = await seedConnector("razorpay");
    const body = JSON.stringify({ event: "payment.captured", payload: {} });
    const good = crypto.createHmac("sha256", "whsec").update(body).digest("hex");

    let res = makeRes();
    await hooks.razorpayWebhook(webhookReq(c.id, body, { "x-razorpay-signature": good }), res);
    assert.equal(res.statusCode, 200);

    res = makeRes();
    await hooks.razorpayWebhook(webhookReq(c.id, body, { "x-razorpay-signature": "00" + good.slice(2) }), res);
    assert.equal(res.statusCode, 401);
});

test("events for a SUSPENDED company are acknowledged and ignored (nothing stored, no gateway retry storm)", async () => {
    reset();
    fake.tables.Workspace = [{ id: "ws1", status: "suspended" }];
    const c = await seedConnector("stripe");
    const body = JSON.stringify({ id: "evt_9", type: "payment_intent.succeeded", data: { object: {} } });
    const res = makeRes();
    await hooks.stripeWebhook(webhookReq(c.id, body, { "stripe-signature": stripeSigned(body, "whsec") }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ignored, "workspace_inactive");
    assert.equal(fake.tables.RawEvent.length, 0);
    assert.equal(processorCalls.length, 0);
});
