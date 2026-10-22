/**
 * Connector event processors.
 *
 * Each processor turns a (verified) provider payload into createOrder / createRefund / createBooking
 * calls. They are used by BOTH the live webhook handlers and the replay tool, so a replayed event
 * runs exactly the code path of the original delivery.
 *
 * Idempotency: orders and refunds are deduplicated on the provider's own IDs by the controllers, so
 * processing the same event twice never double-counts.
 */

import { getConnectorConfig, getNestedValue, ingestMappedOrder } from "../utils/connectorConfig.js";

// ── controller bridge ────────────────────────────────────────────────────────

function captureResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

function assertSucceeded(response, operation) {
    if (response.statusCode >= 400) {
        throw new Error(`${operation} failed (${response.statusCode}): ${response.body?.message ?? "unknown error"}`);
    }
}

async function invoke(fn, workspaceId, body, label, { withApiKey = true } = {}) {
    const req = { workspaceId, body, ip: null, headers: {}, ...(withApiKey ? { apiKey: {} } : {}) };
    const res = captureResponse();
    await fn(req, res);
    assertSucceeded(res, label);
    return res.body;
}

async function resolveDeps(overrides = {}) {
    const deps = { ...overrides };
    if (!deps.createOrder) deps.createOrder = (await import("../controllers/orderController.js")).createOrder;
    if (!deps.createRefund) deps.createRefund = (await import("../controllers/refundController.js")).createRefund;
    if (!deps.createBooking) deps.createBooking = (await import("../controllers/bookingController.js")).createBooking;
    if (!deps.findOrder) {
        const { db } = await import("../src/prisma/db.js");
        deps.findOrder = (workspaceId, externalId) => db.orm.public.Order.where({ workspaceId, externalId }).first();
    }
    return deps;
}

const money = (minor) => minor / 100;

// ── Stripe ───────────────────────────────────────────────────────────────────

async function processStripe({ connector, eventType, payload: event, deps }) {
    const workspaceId = connector.workspaceId;
    const connectorId = connector.id;
    const type = eventType || event?.type;
    const result = {};

    if (type === "payment_intent.succeeded" || type === "charge.succeeded") {
        const pi = event.data.object;
        const checkoutToken = pi.metadata?.attribution_token || pi.metadata?.checkout_token || null;
        const email = pi.receipt_email || pi.metadata?.email || null;
        const externalId = type === "charge.succeeded" ? pi.payment_intent || pi.id : pi.id;
        const amountReceived = pi.amount_received ?? pi.amount_captured ?? pi.amount;

        result.order = await invoke(
            deps.createOrder,
            workspaceId,
            {
                externalId,
                orderedAt: new Date(pi.created * 1000).toISOString(),
                currency: (pi.currency || "usd").toUpperCase(),
                grossAmount: money(pi.amount),
                netAmount: money(amountReceived),
                checkoutToken,
                email,
                connectorId,
                idempotencyKey: externalId,
            },
            "Stripe order ingestion",
        );
    } else if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
        const session = event.data.object;
        if (session.payment_status === "paid") {
            const paymentIntentId =
                typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
            const checkoutToken =
                session.metadata?.attribution_token || session.metadata?.checkout_token || session.client_reference_id || null;
            const amount = money(session.amount_total ?? 0);

            result.order = await invoke(
                deps.createOrder,
                workspaceId,
                {
                    externalId: paymentIntentId || session.id,
                    orderedAt: new Date(session.created * 1000).toISOString(),
                    currency: (session.currency || "usd").toUpperCase(),
                    grossAmount: amount,
                    netAmount: amount,
                    checkoutToken,
                    email: session.customer_details?.email || session.customer_email || null,
                    connectorId,
                    idempotencyKey: paymentIntentId || session.id,
                },
                "Stripe order ingestion",
            );
        }
    } else if (type === "charge.refund.updated") {
        // payload object is a Refund
        const refund = event.data.object;
        if (refund.status === "succeeded") {
            result.refund = await invoke(
                deps.createRefund,
                workspaceId,
                {
                    externalOrderId: refund.payment_intent || refund.charge,
                    amount: money(refund.amount),
                    currency: (refund.currency || "usd").toUpperCase(),
                    externalId: refund.id,
                    refundedAt: new Date(refund.created * 1000).toISOString(),
                },
                "Stripe refund ingestion",
                { withApiKey: false },
            );
        }
    } else if (type === "charge.refunded") {
        const charge = event.data.object;
        const externalOrderId = charge.payment_intent || charge.id;
        const listed = (charge.refunds?.data ?? []).filter((r) => r.status === "succeeded" || r.status === "pending");

        if (listed.length) {
            // Older API versions embed the refunds list on the charge. Each refund is recorded
            // once (deduplicated on the refund id), so multiple refunds on one charge all count.
            const refunds = [];
            for (const refund of listed) {
                refunds.push(
                    await invoke(
                        deps.createRefund,
                        workspaceId,
                        {
                            externalOrderId,
                            amount: money(refund.amount),
                            currency: (refund.currency || charge.currency || "usd").toUpperCase(),
                            externalId: refund.id,
                            refundedAt: new Date(refund.created * 1000).toISOString(),
                        },
                        "Stripe refund ingestion",
                        { withApiKey: false },
                    ),
                );
            }
            result.refund = refunds.length === 1 ? refunds[0] : refunds;
        } else if (Number(charge.amount_refunded) > 0) {
            // Newer API versions omit the refunds list. Derive the new refund as
            // (cumulative refunded on the charge) - (already recorded for the order).
            // The synthetic id embeds the cumulative total so a redelivery is a no-op.
            const order = await deps.findOrder(workspaceId, externalOrderId);
            const alreadyRecorded = BigInt(order?.refundedMinorUnits ?? 0n);
            const delta = BigInt(charge.amount_refunded) - alreadyRecorded;
            if (delta > 0n) {
                result.refund = await invoke(
                    deps.createRefund,
                    workspaceId,
                    {
                        externalOrderId,
                        amount: money(Number(delta)),
                        currency: (charge.currency || "usd").toUpperCase(),
                        externalId: `${charge.id}:refunded:${charge.amount_refunded}`,
                        refundedAt: new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
                    },
                    "Stripe refund ingestion",
                    { withApiKey: false },
                );
            } else {
                result.note = "Refund already recorded";
            }
        }
    }
    return result;
}

// ── Razorpay ─────────────────────────────────────────────────────────────────

async function processRazorpay({ connector, eventType, payload, deps }) {
    const workspaceId = connector.workspaceId;
    const connectorId = connector.id;
    const type = eventType || payload?.event || "unknown";
    const result = {};

    if (type === "payment.captured" || type === "order.paid") {
        const payment = payload.payload?.payment?.entity || {};
        const checkoutToken =
            payment.notes?.attribution_token || payment.notes?.checkout_token || payment.notes?.sessionToken || null;

        result.order = await invoke(
            deps.createOrder,
            workspaceId,
            {
                externalId: payment.id || payment.order_id,
                orderedAt: new Date((payment.created_at || Date.now() / 1000) * 1000).toISOString(),
                currency: (payment.currency || "INR").toUpperCase(),
                grossAmount: money(payment.amount || 0),
                netAmount: money(payment.amount || 0),
                checkoutToken,
                email: payment.email || null,
                phone: payment.contact || null,
                connectorId,
            },
            "Razorpay order ingestion",
        );
    } else if (type === "refund.processed") {
        const refund = payload.payload?.refund?.entity || {};
        if (!refund.id || !refund.payment_id) throw new Error("Razorpay refund event is missing refund.id or refund.payment_id");

        result.refund = await invoke(
            deps.createRefund,
            workspaceId,
            {
                externalOrderId: refund.payment_id,
                amount: money(refund.amount || 0),
                currency: (refund.currency || "INR").toUpperCase(),
                externalId: refund.id,
                refundedAt: new Date((refund.created_at || Date.now() / 1000) * 1000).toISOString(),
                reason: refund.notes?.reason ?? null,
            },
            "Razorpay refund ingestion",
            { withApiKey: false },
        );
    }
    return result;
}

// ── PayPal ───────────────────────────────────────────────────────────────────

const CAPTURE_ID_IN_LINK = /\/captures\/([A-Za-z0-9-]+)/;

async function processPayPal({ connector, eventType, payload, config, deps }) {
    const workspaceId = connector.workspaceId;
    const connectorId = connector.id;
    const type = eventType || payload?.event_type || "unknown";
    const result = {};

    const orderEventTypes = config.orderEventTypes || ["PAYMENT.CAPTURE.COMPLETED"];
    const refundEventTypes = config.refundEventTypes || ["PAYMENT.CAPTURE.REFUNDED"];

    if (orderEventTypes.includes(type)) {
        const fieldMap = {
            externalId: "resource.id",
            orderedAt: "resource.create_time",
            currency: "resource.amount.currency_code",
            grossAmount: "resource.amount.value",
            netAmount: "resource.amount.value",
            email: "resource.payer.email_address",
            checkoutToken: "resource.custom_id",
            ...config.fieldMap,
        };
        result.order = await ingestMappedOrder({
            payload,
            fieldMap,
            connectorId,
            workspaceId,
            req: { ip: null, headers: {} },
            createOrder: deps.createOrder,
        });
    } else if (refundEventTypes.includes(type)) {
        const resource = payload.resource || {};
        const upLink = (resource.links || []).find((link) => link.rel === "up")?.href || "";
        const captureId = upLink.match(CAPTURE_ID_IN_LINK)?.[1] || resource.supplementary_data?.related_ids?.capture_id;
        if (!captureId) throw new Error("Could not determine the original PayPal capture for this refund");

        const value = Number(resource.amount?.value);
        if (!Number.isFinite(value)) throw new Error("PayPal refund amount is missing or invalid");

        result.refund = await invoke(
            deps.createRefund,
            workspaceId,
            {
                externalOrderId: captureId,
                amount: value,
                currency: String(resource.amount?.currency_code || "USD").toUpperCase(),
                externalId: resource.id,
                refundedAt: resource.create_time || new Date().toISOString(),
                reason: resource.note_to_payer ?? null,
            },
            "PayPal refund ingestion",
            { withApiKey: false },
        );
    }
    return result;
}

// ── Shopify ──────────────────────────────────────────────────────────────────

async function processShopify({ connector, eventType: topic, payload, deps }) {
    const workspaceId = connector.workspaceId;
    const connectorId = connector.id;
    const result = {};

    if (topic === "orders/paid" || topic === "orders/create") {
        const order = payload;
        const attributes = [...(order.cart_attributes || []), ...(order.note_attributes || [])];
        const checkoutToken =
            attributes.find((a) => ["attribution_token", "checkout_token"].includes(a.name))?.value || null;

        result.order = await invoke(
            deps.createOrder,
            workspaceId,
            {
                externalId: String(order.id),
                orderedAt: order.processed_at || order.created_at,
                currency: order.currency,
                grossAmount: parseFloat(order.total_price || 0),
                netAmount: parseFloat(order.subtotal_price || order.total_price || 0),
                discountAmount: parseFloat(order.total_discounts || 0),
                taxAmount: parseFloat(order.total_tax || 0),
                checkoutToken,
                email: order.email || order.customer?.email || null,
                phone: order.phone || order.billing_address?.phone || null,
                connectorId,
                items: (order.line_items || []).map((li) => ({
                    name: li.name,
                    quantity: li.quantity,
                    unitAmount: parseFloat(li.price || 0),
                    currency: order.currency,
                    externalId: String(li.id),
                })),
            },
            "Shopify order ingestion",
        );
    } else if (topic === "refunds/create") {
        const refund = payload;
        result.refund = await invoke(
            deps.createRefund,
            workspaceId,
            {
                externalOrderId: String(refund.order_id),
                amount: parseFloat(refund.transactions?.[0]?.amount || 0),
                currency: refund.transactions?.[0]?.currency || "USD",
                externalId: String(refund.id),
                refundedAt: refund.created_at,
                reason: refund.note,
            },
            "Shopify refund ingestion",
            { withApiKey: false },
        );
    }
    return result;
}

// ── Zenoti ───────────────────────────────────────────────────────────────────

async function processZenoti({ connector, eventType, payload, deps }) {
    const workspaceId = connector.workspaceId;
    const connectorId = connector.id;
    const type = eventType || payload?.event_type || payload?.type || "unknown";
    const result = {};

    if (type === "appointment.created" || type === "appointment.booked") {
        const appt = payload.appointment || payload;
        const guest = appt.guest || {};
        const checkoutToken = appt.notes?.match(/attribution_token:([a-f0-9-]+)/)?.[1] || null;

        result.booking = await invoke(
            deps.createBooking,
            workspaceId,
            {
                externalId: String(appt.id || appt.appointment_id),
                appointmentStartAt: appt.start_time || appt.appointment_date,
                currency: connector.config?.currency || "USD",
                bookedValue: parseFloat(appt.price || appt.total || 0),
                checkoutToken,
                email: guest.email || null,
                phone: guest.mobile || guest.phone || null,
                serviceName: appt.service?.name || appt.service_name || null,
                connectorId,
            },
            "Zenoti booking ingestion",
        );
    } else if (type === "invoice.completed" || type === "invoice.paid") {
        const invoice = payload.invoice || payload;
        const guest = invoice.guest || {};

        result.order = await invoke(
            deps.createOrder,
            workspaceId,
            {
                externalId: String(invoice.id || invoice.invoice_id),
                orderedAt: invoice.payment_date || invoice.date || new Date().toISOString(),
                currency: connector.config?.currency || "USD",
                grossAmount: parseFloat(invoice.total || 0),
                netAmount: parseFloat(invoice.sub_total || invoice.total || 0),
                discountAmount: parseFloat(invoice.discount || 0),
                taxAmount: parseFloat(invoice.tax || 0),
                email: guest.email || null,
                phone: guest.mobile || guest.phone || null,
                connectorId,
            },
            "Zenoti order ingestion",
        );
    }
    return result;
}

// ── Generic (also WooCommerce / Square via configurable field map) ───────────

async function processGeneric({ connector, eventType, payload, config, deps }) {
    const workspaceId = connector.workspaceId;
    const connectorId = connector.id;
    const fieldMap = config.fieldMap || {};
    const resolved = eventType || "unknown";
    const result = {};

    const isOrderEvent = (config.orderEventTypes || ["order.paid", "payment.completed"]).includes(resolved);
    const isBookingEvent = (config.bookingEventTypes || ["booking.created"]).includes(resolved);

    if (isOrderEvent) {
        result.order = await ingestMappedOrder({
            payload,
            fieldMap,
            connectorId,
            workspaceId,
            req: { ip: null, headers: {} },
            createOrder: deps.createOrder,
        });
    } else if (isBookingEvent) {
        result.booking = await invoke(
            deps.createBooking,
            workspaceId,
            {
                externalId: String(getNestedValue(payload, fieldMap.externalId) || ""),
                appointmentStartAt: getNestedValue(payload, fieldMap.appointmentStartAt) || new Date().toISOString(),
                currency: String(getNestedValue(payload, fieldMap.currency) || "USD").toUpperCase(),
                bookedValue: parseFloat(getNestedValue(payload, fieldMap.bookedValue) || 0),
                email: getNestedValue(payload, fieldMap.email) || null,
                phone: getNestedValue(payload, fieldMap.phone) || null,
                checkoutToken: getNestedValue(payload, fieldMap.checkoutToken) || null,
                serviceName: getNestedValue(payload, fieldMap.serviceName) || null,
                connectorId,
            },
            "Generic booking ingestion",
        );
    } else {
        result.note = "Unknown event type, stored for replay";
    }
    return result;
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

const PROCESSORS = {
    stripe: processStripe,
    razorpay: processRazorpay,
    paypal: processPayPal,
    shopify: processShopify,
    zenoti: processZenoti,
    generic: processGeneric,
    woocommerce: processGeneric,
    square: processGeneric,
};

export const isReplayable = (connectorType) => connectorType in PROCESSORS;

/**
 * @param {{connector: object, eventType?: string, payload: object, deps?: object}} args
 * @returns {Promise<{order?: object, refund?: object, booking?: object, note?: string}>}
 */
export async function processConnectorEvent({ connector, eventType, payload, deps }) {
    const processor = PROCESSORS[connector.type];
    if (!processor) throw new Error(`No event processor for connector type "${connector.type}"`);
    const resolvedDeps = await resolveDeps(deps);
    const config = getConnectorConfig(connector);
    return processor({ connector, eventType, payload, config, deps: resolvedDeps });
}
