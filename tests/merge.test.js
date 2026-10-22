import "./setup.js";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, makeRes, adminReq } from "./fakeDb.js";

const fake = createFakeDb();
mock.module("../src/prisma/db.js", { namedExports: { db: fake.db }, defaultExport: fake.db });

const { mergeCustomersHandler } = await import("../controllers/customerController.js");
const { isPaidOrder, PAID_ORDER_STATUSES } = await import("../services/customerMerge.js");

const T = fake.tables;
const reset = () => { for (const k of Object.keys(T)) T[k] = []; };
const cust = (id, over = {}) => T.Customer.push({ id, workspaceId: "ws1", mergedIntoId: null, firstSeenAt: "2026-01-01T00:00:00.000Z", ...over });
const ord = (id, customerId, at, over = {}) => T.Order.push({ id, workspaceId: "ws1", customerId, orderedAt: at, status: "paid", isNewCustomer: false, ...over });
const flags = () => Object.fromEntries(T.Order.map((o) => [o.id, o.isNewCustomer]));
const merge = async (body, workspaceId = "ws1") => {
    const req = adminReq(body); req.user.workspaceId = workspaceId;
    const res = makeRes(); await mergeCustomersHandler(req, res); return res;
};

test("paid definition: refunded orders were still paid; pending/voided are not", () => {
    assert.deepEqual(PAID_ORDER_STATUSES, ["paid", "partially_refunded", "refunded"]);
    for (const [status, expected] of [["paid", true], ["partially_refunded", true], ["refunded", true], ["pending", false], ["voided", false]]) {
        assert.equal(isPaidOrder({ status }), expected, status);
    }
});

test("merge: orders combine and new-vs-returning is recomputed over the combined history (earlier source order becomes THE new one)", async () => {
    reset();
    cust("A"); cust("B");
    ord("a1", "A", "2026-01-10T00:00:00.000Z", { isNewCustomer: true });  // target's only order
    ord("b1", "B", "2026-01-02T00:00:00.000Z", { isNewCustomer: true });  // source's earlier first order
    ord("b2", "B", "2026-01-20T00:00:00.000Z", { isNewCustomer: false });
    const res = await merge({ sourceId: "B", targetId: "A" });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(flags(), { a1: false, b1: true, b2: false });
    assert.ok(T.Order.every((o) => o.customerId === "A"));
    assert.equal(res.body.moved.orders, 2);
    assert.equal(res.body.newVsReturningFlagsChanged, 1); // only a1 flipped
    assert.equal(res.body.firstPurchaseAt, "2026-01-02T00:00:00.000Z");
    assert.equal(res.body.lastPurchaseAt, "2026-01-20T00:00:00.000Z");
    assert.equal(T.Customer.find((c) => c.id === "A").firstPurchaseAt, "2026-01-02T00:00:00.000Z");
});

test("merge: a refunded earlier order still makes later orders 'returning'", async () => {
    reset();
    cust("A"); cust("B");
    ord("a1", "A", "2026-02-01T00:00:00.000Z", { isNewCustomer: true });
    ord("b1", "B", "2026-01-01T00:00:00.000Z", { isNewCustomer: true, status: "refunded" });
    await merge({ sourceId: "B", targetId: "A" });
    assert.deepEqual(flags(), { a1: false, b1: true });
});

test("merge: pending/voided orders never become 'new' and are not counted", async () => {
    reset();
    cust("A"); cust("B");
    ord("a1", "A", "2026-02-01T00:00:00.000Z", { isNewCustomer: true });
    ord("b1", "B", "2026-01-01T00:00:00.000Z", { status: "voided" });
    await merge({ sourceId: "B", targetId: "A" });
    assert.deepEqual(flags(), { a1: true, b1: false });
});

test("merge: bookings + visitors move, identifiers are carried over (target wins), source becomes a tombstone, audit written", async () => {
    reset();
    cust("A", { emailHash: null, phoneHash: "ph-A", externalIds: { zenoti: "z-A" }, firstSeenAt: "2026-03-01T00:00:00.000Z" });
    cust("B", { emailHash: "eh-B", emailEnc: Buffer.from("x"), phoneHash: "ph-B", externalIds: { zenoti: "z-B", shopify: "s-B" }, firstSeenAt: "2026-01-01T00:00:00.000Z" });
    T.Booking.push({ id: "bk1", workspaceId: "ws1", customerId: "B" });
    T.Visitor.push({ id: "v1", workspaceId: "ws1", customerId: "B" }, { id: "v2", workspaceId: "ws1", customerId: "A" });
    const res = await merge({ sourceId: "B", targetId: "A" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.moved, { orders: 0, bookings: 1, visitors: 1 });
    assert.ok(T.Booking.every((b) => b.customerId === "A") && T.Visitor.every((v) => v.customerId === "A"));
    const A = T.Customer.find((c) => c.id === "A");
    assert.equal(A.emailHash, "eh-B");
    assert.equal(A.phoneHash, "ph-A", "target's own phone hash is kept");
    assert.deepEqual(A.externalIds, { zenoti: "z-A", shopify: "s-B" });
    assert.equal(A.firstSeenAt, "2026-01-01T00:00:00.000Z");
    assert.equal(T.Customer.find((c) => c.id === "B").mergedIntoId, "A");
    const log = T.AuditLog.find((l) => l.action === "customer.merged");
    assert.deepEqual([log.workspaceId, log.metadata.sourceId, log.metadata.targetId, log.metadata.bookings], ["ws1", "B", "A", 1]);
});

test("merge: validation, tombstone and tenant guards", async () => {
    reset();
    cust("A"); cust("B"); cust("C", { mergedIntoId: "A" }); cust("X", { workspaceId: "OTHER" });
    assert.equal((await merge({ sourceId: "A", targetId: "A" })).statusCode, 400);
    assert.equal((await merge({ sourceId: "A" })).statusCode, 400);
    assert.equal((await merge({ sourceId: "C", targetId: "B" })).body.code, "already_merged");
    assert.equal((await merge({ sourceId: "B", targetId: "C" })).body.code, "target_merged");
    assert.equal((await merge({ sourceId: "X", targetId: "A" })).statusCode, 404, "other company's customer must be invisible");
    assert.equal((await merge({ sourceId: "B", targetId: "A" }, "OTHER")).statusCode, 404);
    // nothing changed by the rejected attempts
    assert.equal(T.Customer.find((c) => c.id === "B").mergedIntoId, null);
    assert.equal(T.AuditLog.length, 0);
});

test("merge is atomic: a failure midway leaves everything untouched", async () => {
    reset();
    cust("A"); cust("B");
    ord("b1", "B", "2026-01-02T00:00:00.000Z", { isNewCustomer: true });
    fake.state.failOn = { AuditLog: true };
    const res = await merge({ sourceId: "B", targetId: "A" });
    fake.state.failOn = {};
    assert.equal(res.statusCode, 500);
    assert.equal(T.Order[0].customerId, "B");
    assert.equal(T.Customer.find((c) => c.id === "B").mergedIntoId, null);
});
