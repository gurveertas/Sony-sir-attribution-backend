import { fakeDeps } from "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";

const { processConnectorEvent } = await import("../services/connectorProcessors.js");
const { prepareConnectorConfig } = await import("../utils/connectorConfig.js");

const connector = (type, config = null) => ({ id: "conn1", workspaceId: "ws1", type, ...(config ? prepareConnectorConfig(config) : {}) });

test("stripe payment_intent.succeeded -> order with token, major units, idempotency key", async () => {
    const { deps, calls } = fakeDeps();
    const event = { type: "payment_intent.succeeded", data: { object: {
        id: "pi_1", created: 1_700_000_000, currency: "usd", amount: 12345, amount_received: 12345,
        receipt_email: "a@b.com", metadata: { attribution_token: "tok-1" } } } };
    const out = await processConnectorEvent({ connector: connector("stripe"), eventType: event.type, payload: event, deps });
    assert.equal(calls.orders.length, 1);
    assert.deepEqual(
        { ...calls.orders[0], orderedAt: undefined },
        { externalId: "pi_1", orderedAt: undefined, currency: "USD", grossAmount: 123.45, netAmount: 123.45,
          checkoutToken: "tok-1", email: "a@b.com", connectorId: "conn1", idempotencyKey: "pi_1" },
    );
    assert.equal(calls.orders[0].orderedAt, new Date(1_700_000_000 * 1000).toISOString());
    assert.ok(out.order);
});

test("stripe checkout.session.completed: only when paid; token from client_reference_id fallback", async () => {
    const { deps, calls } = fakeDeps();
    const mk = (status) => ({ type: "checkout.session.completed", data: { object: {
        id: "cs_1", payment_intent: "pi_9", payment_status: status, created: 1_700_000_000, currency: "eur",
        amount_total: 5000, client_reference_id: "tok-ref", customer_details: { email: "x@y.z" }, metadata: {} } } });
    await processConnectorEvent({ connector: connector("stripe"), eventType: "checkout.session.completed", payload: mk("unpaid"), deps });
    assert.equal(calls.orders.length, 0);
    await processConnectorEvent({ connector: connector("stripe"), eventType: "checkout.session.completed", payload: mk("paid"), deps });
    assert.equal(calls.orders[0].externalId, "pi_9");
    assert.equal(calls.orders[0].checkoutToken, "tok-ref");
    assert.equal(calls.orders[0].currency, "EUR");
});

test("stripe charge.refunded with embedded refunds list: every succeeded refund recorded once by refund id", async () => {
    const { deps, calls } = fakeDeps();
    const event = { type: "charge.refunded", created: 1_700_000_500, data: { object: {
        id: "ch_1", payment_intent: "pi_1", currency: "usd", amount_refunded: 3000,
        refunds: { data: [
            { id: "re_1", amount: 1000, currency: "usd", created: 1_700_000_100, status: "succeeded" },
            { id: "re_2", amount: 2000, currency: "usd", created: 1_700_000_200, status: "succeeded" },
            { id: "re_3", amount: 500, currency: "usd", created: 1_700_000_300, status: "failed" },
        ] } } } };
    await processConnectorEvent({ connector: connector("stripe"), eventType: event.type, payload: event, deps });
    assert.deepEqual(calls.refunds.map((r) => [r.externalId, r.amount, r.externalOrderId]), [["re_1", 10, "pi_1"], ["re_2", 20, "pi_1"]]);
});

test("stripe charge.refunded WITHOUT refunds list (newer API versions): records only the new delta", async () => {
    const { deps, calls } = fakeDeps({ order: { refundedMinorUnits: 1000n } });
    const event = { type: "charge.refunded", created: 1_700_000_500, data: { object: {
        id: "ch_1", payment_intent: "pi_1", currency: "usd", amount_refunded: 3000 } } };
    await processConnectorEvent({ connector: connector("stripe"), eventType: event.type, payload: event, deps });
    assert.equal(calls.refunds.length, 1);
    assert.equal(calls.refunds[0].amount, 20);
    assert.equal(calls.refunds[0].externalId, "ch_1:refunded:3000", "id embeds the cumulative total so redelivery is a no-op");

    const none = fakeDeps({ order: { refundedMinorUnits: 3000n } });
    const r = await processConnectorEvent({ connector: connector("stripe"), eventType: event.type, payload: event, deps: none.deps });
    assert.equal(none.calls.refunds.length, 0);
    assert.equal(r.note, "Refund already recorded");
});

test("stripe charge.refund.updated: only succeeded refunds", async () => {
    const { deps, calls } = fakeDeps();
    const mk = (status) => ({ type: "charge.refund.updated", data: { object: { id: "re_9", payment_intent: "pi_2", amount: 700, currency: "gbp", created: 1_700_000_000, status } } });
    await processConnectorEvent({ connector: connector("stripe"), eventType: "charge.refund.updated", payload: mk("pending"), deps });
    assert.equal(calls.refunds.length, 0);
    await processConnectorEvent({ connector: connector("stripe"), eventType: "charge.refund.updated", payload: mk("succeeded"), deps });
    assert.deepEqual([calls.refunds[0].externalId, calls.refunds[0].amount, calls.refunds[0].currency], ["re_9", 7, "GBP"]);
});

test("razorpay payment.captured -> order (token from notes); refund.processed -> refund linked to payment id", async () => {
    const { deps, calls } = fakeDeps();
    const cap = { event: "payment.captured", payload: { payment: { entity: {
        id: "pay_1", amount: 49900, currency: "INR", created_at: 1_700_000_000, email: "r@x.in", contact: "+911234567890",
        notes: { attribution_token: "tok-rz" } } } } };
    await processConnectorEvent({ connector: connector("razorpay"), eventType: cap.event, payload: cap, deps });
    assert.deepEqual([calls.orders[0].externalId, calls.orders[0].grossAmount, calls.orders[0].checkoutToken, calls.orders[0].phone],
        ["pay_1", 499, "tok-rz", "+911234567890"]);

    const ref = { event: "refund.processed", payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_1", amount: 10000, currency: "INR", created_at: 1_700_001_000 } } } };
    await processConnectorEvent({ connector: connector("razorpay"), eventType: ref.event, payload: ref, deps });
    assert.deepEqual([calls.refunds[0].externalOrderId, calls.refunds[0].externalId, calls.refunds[0].amount], ["pay_1", "rfnd_1", 100]);

    await assert.rejects(
        processConnectorEvent({ connector: connector("razorpay"), eventType: "refund.processed", payload: { payload: { refund: { entity: {} } } }, deps }),
        /missing refund/,
    );
});

test("paypal PAYMENT.CAPTURE.COMPLETED -> order via default field map; REFUNDED -> refund against capture id from 'up' link", async () => {
    const { deps, calls } = fakeDeps();
    const cfg = connector("paypal", { clientId: "c", clientSecret: "s", webhookId: "W", paypalEnvironment: "sandbox" });

    const done = { event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {
        id: "CAP123", create_time: "2026-01-02T03:04:05Z", amount: { currency_code: "USD", value: "25.50" },
        custom_id: "tok-pp", payer: { email_address: "p@q.r" } } };
    await processConnectorEvent({ connector: cfg, eventType: done.event_type, payload: done, deps });
    assert.deepEqual([calls.orders[0].externalId, calls.orders[0].grossAmount, calls.orders[0].checkoutToken, calls.orders[0].email],
        ["CAP123", 25.5, "tok-pp", "p@q.r"]);

    const refund = { event_type: "PAYMENT.CAPTURE.REFUNDED", resource: {
        id: "REF9", create_time: "2026-01-03T00:00:00Z", amount: { currency_code: "USD", value: "5.00" },
        links: [{ rel: "self", href: "https://api.paypal.com/v2/payments/refunds/REF9" },
                { rel: "up", href: "https://api.paypal.com/v2/payments/captures/CAP123" }] } };
    await processConnectorEvent({ connector: cfg, eventType: refund.event_type, payload: refund, deps });
    assert.deepEqual([calls.refunds[0].externalOrderId, calls.refunds[0].externalId, calls.refunds[0].amount], ["CAP123", "REF9", 5]);

    const orphan = { event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "R", amount: { currency_code: "USD", value: "1.00" }, links: [] } };
    await assert.rejects(processConnectorEvent({ connector: cfg, eventType: orphan.event_type, payload: orphan, deps }), /original PayPal capture/);
});

test("a downstream 4xx (e.g. refund before order exists) surfaces as an error so the event is marked failed and replayable", async () => {
    const failing = { createRefund: async (_req, res) => res.status(404).json({ message: "Order not found" }) };
    const { deps } = fakeDeps();
    const ref = { event: "refund.processed", payload: { refund: { entity: { id: "r", payment_id: "p", amount: 100, currency: "INR" } } } };
    await assert.rejects(
        processConnectorEvent({ connector: connector("razorpay"), eventType: ref.event, payload: ref, deps: { ...deps, ...failing } }),
        /Razorpay refund ingestion failed \(404\): Order not found/,
    );
});

test("shopify orders/paid + refunds/create mapping", async () => {
    const { deps, calls } = fakeDeps();
    const order = { id: 77, currency: "USD", total_price: "100.00", subtotal_price: "90.00", total_discounts: "5.00", total_tax: "10.00",
        processed_at: "2026-01-01T00:00:00Z", email: "s@h.p", note_attributes: [{ name: "attribution_token", value: "tok-sh" }],
        line_items: [{ id: 1, name: "Shirt", quantity: 2, price: "45.00" }] };
    await processConnectorEvent({ connector: connector("shopify"), eventType: "orders/paid", payload: order, deps });
    assert.deepEqual([calls.orders[0].externalId, calls.orders[0].netAmount, calls.orders[0].checkoutToken, calls.orders[0].items[0].unitAmount], ["77", 90, "tok-sh", 45]);
    await processConnectorEvent({ connector: connector("shopify"), eventType: "refunds/create", payload: { id: 5, order_id: 77, created_at: "2026-01-02T00:00:00Z", transactions: [{ amount: "10.00", currency: "USD" }] }, deps });
    assert.deepEqual([calls.refunds[0].externalOrderId, calls.refunds[0].amount], ["77", 10]);
});

test("zenoti appointment + invoice mapping", async () => {
    const { deps, calls } = fakeDeps();
    const z = { ...connector("zenoti"), config: { currency: "AED" } };
    await processConnectorEvent({ connector: z, eventType: "appointment.created", deps,
        payload: { appointment: { id: "a1", start_time: "2026-02-01T10:00:00Z", price: "80", notes: "x attribution_token:abc-123 y", guest: { email: "g@z.c" }, service: { name: "Cut" } } } });
    assert.deepEqual([calls.bookings[0].externalId, calls.bookings[0].currency, calls.bookings[0].checkoutToken, calls.bookings[0].serviceName], ["a1", "AED", "abc-123", "Cut"]);
    await processConnectorEvent({ connector: z, eventType: "invoice.paid", deps, payload: { invoice: { id: "i1", total: "100", sub_total: "90", guest: {} } } });
    assert.equal(calls.orders[0].externalId, "i1");
});

test("generic: configured field map for orders; unknown types are stored, not failed", async () => {
    const { deps, calls } = fakeDeps();
    const g = connector("generic", { webhookSecret: "s", fieldMap: { externalId: "o.id", orderedAt: "o.at", currency: "o.cur", grossAmount: "o.total", email: "o.mail" } });
    await processConnectorEvent({ connector: g, eventType: "order.paid", deps, payload: { o: { id: 9, at: "2026-01-01T00:00:00Z", cur: "usd", total: "12.5", mail: "m@n.o" } } });
    assert.deepEqual([calls.orders[0].externalId, calls.orders[0].currency, calls.orders[0].grossAmount], ["9", "USD", 12.5]);
    const out = await processConnectorEvent({ connector: g, eventType: "something.else", deps, payload: {} });
    assert.match(out.note, /Unknown event type/);
});

test("unsupported connector type has no processor", async () => {
    const { deps } = fakeDeps();
    await assert.rejects(processConnectorEvent({ connector: connector("nope"), eventType: "x", payload: {}, deps }), /No event processor/);
});
