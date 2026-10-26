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

import { AsyncLocalStorage } from "node:async_hooks";
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

// The connector, not the payload, decides which connector an event belongs to (req.connector), and the
// time the raw event was received anchors defaults (booking time, refund date) so replays are identical.
const contextStore = new AsyncLocalStorage();
const currentCtx = () => contextStore.getStore() ?? null;

async function invoke(fn, workspaceId, body, label, { withApiKey = true } = {}) {
    const req = {
        workspaceId,
        body,
        ip: null,
        headers: {},
        connector: currentCtx()?.connector ? { id: currentCtx().connector.id, type: currentCtx().connector.type } : null,
        receivedAt: currentCtx()?.receivedAt ?? null,
        isTest: Boolean(currentCtx()?.isTest),
        ...(withApiKey ? { apiKey: {} } : {}),
    };
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
    if (!deps.updateBookingByExternalId) {
        deps.updateBookingByExternalId = async (workspaceId, externalId, body, ctx) =>
            (await import("./ingestion.js")).updateBookingByExternalId(workspaceId, externalId, body, ctx);
    }
    if (!deps.resolveGuest) {
        deps.resolveGuest = async (workspaceId, identifiers) => {
            const [{ db }, { resolveCustomer }] = await Promise.all([import("../src/prisma/db.js"), import("./identityService.js")]);
            const { customer, isNew } = await resolveCustomer(db, workspaceId, identifiers);
            return { customerId: customer?.id ?? null, isNew };
        };
    }
    if (!deps.mergeCustomers) {
        deps.mergeCustomers = async (workspaceId, body) => (await import("../controllers/customerController.js")).mergeFromSource(workspaceId, body);
    }
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

        // Section 6: gross = before discounts, excluding tax; net = gross - discounts.
        // subtotal_price is after discounts and before shipping/tax (tax-inclusive shops include tax).
        const discount = parseFloat(order.total_discounts || 0);
        const tax = parseFloat(order.total_tax || 0);
        let subtotal = parseFloat(order.subtotal_price ?? order.total_price ?? 0);
        if (order.taxes_included) subtotal -= tax;
        const net = Math.max(0, Math.round(subtotal * 100) / 100);
        result.order = await invoke(
            deps.createOrder,
            workspaceId,
            {
                externalId: String(order.id),
                orderedAt: order.processed_at || order.created_at,
                currency: order.currency,
                grossAmount: Math.round((net + discount) * 100) / 100,
                netAmount: net,
                discountAmount: discount,
                taxAmount: tax,
                customerExternalId: order.customer?.id ? String(order.customer.id) : null,
                customerExternalIdKey: "shopify",
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
// Repackages the guest, appointment and invoice handlers. Event names are matched loosely because
// Zenoti tenants use both "appointment.created" and "AppointmentGroup.Created" style names.

const ZENOTI_STATUS = {
    "-2": "no_show", "-1": "cancelled", 0: "scheduled", 1: "completed", 2: "confirmed", 4: "confirmed",
    new: "scheduled", booked: "scheduled", open: "scheduled", confirmed: "confirmed", confirm: "confirmed",
    checkin: "confirmed", "checked_in": "confirmed", closed: "completed", completed: "completed",
    cancelled: "cancelled", canceled: "cancelled", deleted: "cancelled", noshow: "no_show", "no_show": "no_show",
};

const zenotiToken = (...texts) => {
    for (const t of texts) {
        const m = String(t ?? "").match(/(?:attribution_token|checkout_token|wtok)[:=]\s*([A-Za-z0-9-]{3,64})/);
        if (m) return m[1];
    }
    return null;
};

function zenotiKind(type) {
    const t = String(type || "").toLowerCase().replace(/appointmentgroup/, "appointment").replace(/[\s_-]/g, "");
    if (/^guest\.merged?$/.test(t)) return "guest_merged";
    if (/^guest\./.test(t)) return "guest";
    if (/^invoice\.(completed|paid|closed)$/.test(t)) return "invoice";
    if (/^invoice\.(refunded|refund)$/.test(t)) return "invoice_refund";
    if (/^appointment\.(created|booked)$/.test(t)) return "appointment_created";
    if (/^appointment\.(cancelled|canceled|deleted)$/.test(t)) return "appointment_cancelled";
    if (/^appointment\.(noshow)$/.test(t)) return "appointment_no_show";
    if (/^appointment\.(updated|rescheduled|confirmed|checkin|checkedin|completed|closed)$/.test(t)) return "appointment_updated";
    return null;
}

async function processZenoti({ connector, eventType, payload, deps }) {
    const workspaceId = connector.workspaceId;
    const connectorId = connector.id;
    const type = eventType || payload?.event_type || payload?.type || "unknown";
    const currency = connector.config?.currency || payload?.currency || "USD";
    const kind = zenotiKind(type);
    const result = {};

    if (kind === "guest_merged") {
        // Zenoti merged two guest profiles: combine their history here too
        const from = payload.source_guest_id ?? payload.merged_guest_id ?? payload.guest?.merged_from;
        const into = payload.target_guest_id ?? payload.primary_guest_id ?? payload.guest?.id;
        if (!from || !into) throw new Error("Zenoti guest merge event needs the two guest ids");
        result.merge = await deps.mergeCustomers(workspaceId, { sourceExternalId: String(from), targetExternalId: String(into), externalIdKey: "zenoti" });
        return result;
    }

    if (kind === "guest") {
        const guest = payload.guest || payload;
        const email = guest.email || guest.personal_info?.email || null;
        const phone = guest.mobile || guest.phone || guest.personal_info?.mobile_phone?.number || null;
        if (guest.id || email || phone) {
            result.guest = await deps.resolveGuest(workspaceId, { email, phone, externalId: guest.id ? String(guest.id) : null, externalIdKey: "zenoti" });
        }
        return result;
    }

    if (kind?.startsWith("appointment")) {
        const appt = payload.appointment || payload;
        const guest = appt.guest || {};
        const externalId = String(appt.id || appt.appointment_id || appt.appointment_group_id || "");
        if (!externalId) throw new Error("Zenoti appointment event has no appointment id");
        const rawStatus = appt.status ?? appt.appointment_status;
        const mapped = ZENOTI_STATUS[String(rawStatus).toLowerCase()] ?? ZENOTI_STATUS[rawStatus] ?? null;

        if (kind === "appointment_created") {
            result.booking = await invoke(
                deps.createBooking,
                workspaceId,
                {
                    externalId,
                    appointmentStartAt: appt.start_time || appt.appointment_date || appt.start_date,
                    appointmentEndAt: appt.end_time || null,
                    bookedAt: appt.created_date || appt.booked_on || undefined,
                    currency,
                    bookedValue: parseFloat(appt.price?.sales ?? appt.price ?? appt.total ?? 0),
                    status: mapped && mapped !== "completed" ? mapped : undefined,
                    checkoutToken: zenotiToken(appt.notes, appt.booking_notes, appt.utm_content, appt.utm_campaign),
                    email: guest.email || null,
                    phone: guest.mobile || guest.phone || null,
                    customerExternalId: guest.id ? String(guest.id) : null,
                    customerExternalIdKey: "zenoti",
                    serviceName: appt.service?.name || appt.service_name || null,
                    locationExternalId: appt.center_id || appt.center?.id || null,
                    gclid: appt.gclid || null,
                    fbclid: appt.fbclid || null,
                    connectorId,
                },
                "Zenoti booking ingestion",
            );
            return result;
        }

        const status =
            kind === "appointment_cancelled" ? "cancelled" : kind === "appointment_no_show" ? "no_show" : mapped ?? undefined;
        result.booking = await deps.updateBookingByExternalId(
            workspaceId,
            externalId,
            {
                status,
                appointmentStartAt: appt.start_time || appt.appointment_date || undefined,
                bookedValue: appt.price?.sales ?? appt.price ?? undefined,
                reason: appt.cancellation_reason || appt.reason || null,
            },
            { connectorId, receivedAt: currentCtx()?.receivedAt ?? null },
        );
        return result;
    }

    if (kind === "invoice") {
        const invoice = payload.invoice || payload;
        const guest = invoice.guest || {};
        const tax = parseFloat(invoice.tax ?? invoice.total_tax ?? 0);
        const discount = parseFloat(invoice.discount ?? invoice.total_discount ?? 0);
        const total = parseFloat(invoice.total ?? invoice.total_price ?? 0);
        // revenue excludes tax: sub_total when Zenoti sends it, otherwise total - tax
        const net = invoice.sub_total !== undefined ? parseFloat(invoice.sub_total) : Math.max(0, total - tax);
        const appointmentId =
            invoice.appointment_id || invoice.appointment_group_id || invoice.appointments?.[0]?.appointment_id ||
            (invoice.items || invoice.invoice_items || []).find((i) => i.appointment_id)?.appointment_id || null;

        result.order = await invoke(
            deps.createOrder,
            workspaceId,
            {
                externalId: String(invoice.id || invoice.invoice_id),
                orderedAt: invoice.payment_date || invoice.closed_date || invoice.date || currentCtx()?.receivedAt || new Date().toISOString(),
                currency,
                grossAmount: Math.round((net + discount) * 100) / 100,
                netAmount: net,
                discountAmount: discount,
                taxAmount: tax,
                bookingExternalId: appointmentId ? String(appointmentId) : null,
                checkoutToken: zenotiToken(invoice.notes),
                email: guest.email || null,
                phone: guest.mobile || guest.phone || null,
                customerExternalId: guest.id ? String(guest.id) : null,
                customerExternalIdKey: "zenoti",
                locationExternalId: invoice.center_id || invoice.center?.id || null,
                items: (invoice.items || invoice.invoice_items || []).map((it) => ({
                    name: it.name || it.item_name || "Service",
                    quantity: it.quantity || 1,
                    unitAmount: parseFloat(it.price ?? it.final_price ?? 0),
                })),
                connectorId,
            },
            "Zenoti order ingestion",
        );
        // the visit happened: a paid invoice completes its booking
        if (appointmentId) {
            try {
                await deps.updateBookingByExternalId(workspaceId, String(appointmentId), { status: "completed" }, { connectorId, receivedAt: currentCtx()?.receivedAt ?? null });
            } catch {
                /* invoice without a known booking is fine */
            }
        }
        return result;
    }

    if (kind === "invoice_refund") {
        const refund = payload.refund || payload;
        result.refund = await invoke(
            deps.createRefund,
            workspaceId,
            {
                externalOrderId: String(refund.invoice_id || refund.id),
                amount: parseFloat(refund.amount ?? refund.refund_amount ?? 0),
                currency,
                externalId: refund.refund_id ? String(refund.refund_id) : `${refund.invoice_id || refund.id}:refund:${refund.amount ?? refund.refund_amount}`,
                refundedAt: refund.refund_date || refund.date || undefined,
                reason: refund.reason ?? null,
            },
            "Zenoti refund ingestion",
            { withApiKey: false },
        );
        return result;
    }

    result.note = "Unknown event type, stored for replay";
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
    const isBookingUpdate = (config.bookingUpdateEventTypes || ["booking.updated", "booking.cancelled"]).includes(resolved);
    const isRefundEvent = (config.refundEventTypes || ["order.refunded", "refund.created"]).includes(resolved);

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
                bookedAt: getNestedValue(payload, fieldMap.bookedAt) || undefined,
                visitorId: getNestedValue(payload, fieldMap.visitorId) || null,
                locationExternalId: getNestedValue(payload, fieldMap.locationExternalId) || null,
                connectorId,
            },
            "Generic booking ingestion",
        );
    } else if (isBookingUpdate) {
        const externalId = String(getNestedValue(payload, fieldMap.externalId) || "");
        if (!externalId) throw new Error("Mapped booking externalId is missing");
        result.booking = await deps.updateBookingByExternalId(
            workspaceId,
            externalId,
            {
                status: resolved.endsWith("cancelled") ? "cancelled" : getNestedValue(payload, fieldMap.status) || undefined,
                appointmentStartAt: getNestedValue(payload, fieldMap.appointmentStartAt) || undefined,
                bookedValue: getNestedValue(payload, fieldMap.bookedValue) ?? undefined,
            },
            { connectorId, receivedAt: currentCtx()?.receivedAt ?? null },
        );
    } else if (isRefundEvent) {
        const refundMap = { externalOrderId: "order_id", amount: "amount", currency: "currency", externalId: "id", refundedAt: "created_at", ...(config.refundFieldMap || {}) };
        result.refund = await invoke(
            deps.createRefund,
            workspaceId,
            {
                externalOrderId: String(getNestedValue(payload, refundMap.externalOrderId) ?? ""),
                amount: Number(getNestedValue(payload, refundMap.amount)),
                currency: String(getNestedValue(payload, refundMap.currency) || "USD").toUpperCase(),
                externalId: getNestedValue(payload, refundMap.externalId) ? String(getNestedValue(payload, refundMap.externalId)) : null,
                refundedAt: getNestedValue(payload, refundMap.refundedAt) || undefined,
            },
            "Generic refund ingestion",
            { withApiKey: false },
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
export async function processConnectorEvent({ connector, eventType, payload, deps, receivedAt = null, isTest = false }) {
    const processor = PROCESSORS[connector.type];
    if (!processor) throw new Error(`No event processor for connector type "${connector.type}"`);
    const resolvedDeps = await resolveDeps(deps);
    const config = getConnectorConfig(connector);
    // AsyncLocalStorage keeps the context per event even when events of several companies interleave.
    return contextStore.run({ connector, receivedAt, isTest }, () =>
        processor({ connector, eventType, payload, config, deps: resolvedDeps }),
    );
}
