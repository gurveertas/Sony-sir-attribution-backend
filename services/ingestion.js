/**
 * The conversion pipeline (DFD level 2, processes 4.0 -> 5.0 -> 6.0) — ONE implementation used by
 *   - the public API (POST /v1/orders, /v1/bookings, /v1/refunds),
 *   - every connector (Stripe, Shopify, Razorpay, PayPal, Zenoti, generic) through the event queue,
 *   - replay of stored raw events and the attribution re-run tool.
 *
 *   payload ─► normalise to a canonical order/booking ─► idempotency (external id) ─► resolve customer
 *     ─► find touches:  booking link ─► checkout token ─► email/phone-linked visitors ─► visitor id
 *                       ─► click id ─► none ("Direct / unknown" + reason code)
 *     ─► keep touches inside the lookback window ─► credit rows for EVERY model ─► new/returning flag
 *     ─► FX snapshot ─► (after commit) rollup refresh + outbound webhooks
 *
 * Determinism: nothing here depends on "now" except as a last-resort default, so replaying a stored
 * event (or re-running attribution) produces the same rows.
 */

import { db } from "../src/prisma/db.js";
import { tenantDb } from "./tenantDb.js";
import { resolveCustomer, linkVisitorToCustomer, getCustomerTouches, ensureVisitor } from "./identityService.js";
import { filterTouches, buildCreditRows, classifyChannel } from "./attributionEngine.js";
import { recomputeNewVsReturning, isPaidOrder } from "./customerMerge.js";
import { dispatchWebhook } from "./webhookDispatcher.js";
import { noteWrite, invalidateRollups } from "./rollups.js";
import { findRate } from "./fx.js";
import { readMoney, isCurrencyCode, MoneyInputError, allocateMinor } from "../utils/money.js";

export class IngestError extends Error {
    constructor(statusCode, message, code = "validation_error") {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}

export const CLICK_ID_FIELDS = ["gclid", "fbclid", "ttclid", "msclkid"];
export const BOOKING_STATUSES = ["scheduled", "confirmed", "completed", "cancelled", "rescheduled", "no_show"];
export const ORDER_STATUSES = ["pending", "paid", "voided"];

const iso = (v) => new Date(v).toISOString();
const validDate = (v) => v !== undefined && v !== null && v !== "" && Number.isFinite(Date.parse(v));
const str = (v, max = 500) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, max));

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

async function loadWorkspaceContext(client, workspaceId) {
    const orm = client.orm.public;
    const workspace = await orm.Workspace.where({ id: workspaceId }).first();
    if (!workspace) throw new IngestError(404, "Workspace not found", "not_found");
    const rules = (await orm.ChannelMappingRule.where({ workspaceId }).all()).filter((r) => r.isActive !== false);
    return { workspace, rules };
}

function readClickIds(body) {
    const out = {};
    for (const f of CLICK_ID_FIELDS) {
        const v = body?.[f] ?? body?.clickIds?.[f];
        if (v) out[f] = String(v).slice(0, 500);
    }
    return out;
}

async function resolveLocationId(t, body) {
    if (body.locationId) {
        const loc = await t.Location.where({ id: String(body.locationId) }).first().catch(() => null);
        if (!loc) throw new IngestError(400, "locationId does not belong to this company");
        return loc.id;
    }
    const ext = body.locationExternalId ?? body.centerId;
    if (ext) {
        const all = await t.Location.all();
        const hit = all.find((l) => Object.values(l.externalIds ?? {}).map(String).includes(String(ext)));
        return hit?.id ?? null;
    }
    return null;
}

const withChannels = (touches, rules) => touches.map((t) => ({ ...t, channel: classifyChannel(t, rules) }));

async function loadTouchesByIds(t, ids) {
    const out = [];
    for (const id of [...new Set(ids)].filter(Boolean)) {
        const touch = await t.Touch.where({ id }).first();
        if (touch) out.push(touch);
    }
    return out;
}

/** Touches that got credit on a booking (any model) — what an invoice for it inherits. */
async function bookingTouches(t, booking) {
    const credits = await t.AttributionCredit.where({ bookingId: booking.id }).all();
    const ids = credits.filter((c) => c.touchId).map((c) => c.touchId);
    const reason = credits.find((c) => !c.touchId)?.reasonCode ?? null;
    return { touches: await loadTouchesByIds(t, ids), reason };
}

async function findBooking(t, body) {
    if (body.bookingId) return t.Booking.where({ id: String(body.bookingId) }).first().catch(() => null);
    if (body.bookingExternalId) return t.Booking.where({ externalId: String(body.bookingExternalId) }).first();
    return null;
}

async function syntheticClickTouch(t, field, value, at, rules, isTest) {
    const visitor = await ensureVisitor({ orm: { public: t } }, t.workspaceId, `click:${field}:${value}`.slice(0, 200));
    const touch = { visitorId: visitor.id, [field]: value, touchedAt: iso(at), isTest };
    touch.channel = classifyChannel(touch, rules);
    return t.Touch.create(touch);
}

/**
 * The matching waterfall. Returns the touches that receive credit and how they were found.
 * @returns {Promise<{touches, matchMethod, reasonCode, session, booking, attributedAt}>}
 */
async function resolveTouches(t, ctx, input) {
    const { rules, workspace } = ctx;
    const lookback = workspace.lookbackDays || 30;
    const overrides = workspace.lookbackOverrides || {};
    let firstReason = null;
    let sawCandidates = false;
    const note = (r) => {
        if (!firstReason) firstReason = r;
    };
    const keep = (touches, at) => {
        if (touches.length) sawCandidates = true;
        return filterTouches(withChannels(touches, rules), lookback, at, overrides);
    };

    // 1. an invoice for a booking inherits the booking's credit ("credit carries forward")
    let booking = input.kind === "order" ? input.booking : null;
    let session = null;

    if (input.checkoutToken) {
        session = await t.CheckoutSession.where({ token: String(input.checkoutToken) }).first().catch(() => null);
        if (!session) note("token_not_found");
        else if (input.kind === "order" && !booking && session.consumedBookingId) {
            booking = await t.Booking.where({ id: session.consumedBookingId }).first();
        }
    }

    if (booking) {
        const { touches, reason } = await bookingTouches(t, booking);
        const at = booking.bookedAt || booking.createdAt;
        if (touches.length) {
            // no second lookback: the booking already applied it when it was attributed
            const sorted = withChannels(touches, rules).sort((a, b) => new Date(a.touchedAt) - new Date(b.touchedAt));
            return { touches: sorted, matchMethod: booking.matchMethod, reasonCode: null, session, booking, attributedAt: at };
        }
        note(reason || "booking_unattributed");
    }

    // 2. checkout token -> the touches frozen when checkout started
    if (session) {
        const usedByOther =
            (session.consumedOrderId && session.consumedOrderId !== input.selfId) ||
            (session.consumedBookingId && input.kind === "booking" && session.consumedBookingId !== input.selfId);
        const expired = new Date(input.at) > new Date(session.expiresAt);
        if (usedByOther) note("token_already_used");
        else if (expired) note("token_expired");
        else {
            const ids = (Array.isArray(session.frozenTouches) ? session.frozenTouches : []).map((x) => x?.id);
            const touches = keep(await loadTouchesByIds(t, ids), input.at);
            if (touches.length) return { touches, matchMethod: "token", reasonCode: null, session, booking, attributedAt: input.at };
            note(ids.length ? "outside_lookback" : "token_without_touches");
        }
    }

    // 3. email / phone linked to a known visitor
    if (input.customer) {
        const touches = keep(await getCustomerTouches({ orm: { public: t } }, t.workspaceId, input.customer.id), input.at);
        if (touches.length) {
            const method = input.matchedBy === "phone" ? "phone" : input.matchedBy === "email" ? "email" : input.customer.emailHash ? "email" : "phone";
            return { touches, matchMethod: method, reasonCode: null, session, booking, attributedAt: input.at };
        }
    }

    // 4. the site passed its first-party visitor id
    if (input.visitorId) {
        const visitor = await t.Visitor.where({ visitorId: String(input.visitorId) }).first();
        if (visitor) {
            const touches = keep(await t.Touch.where({ visitorId: visitor.id }).all(), input.at);
            if (touches.length) return { touches, matchMethod: "visitor_id", reasonCode: null, session, booking, attributedAt: input.at };
        } else note("unknown_visitor");
    }

    // 5. click id in the payload: use the visit it came from, or build a touch from it
    for (const field of CLICK_ID_FIELDS) {
        const value = input.clickIds?.[field];
        if (!value) continue;
        const clicked = await t.Touch.where({ [field]: value }).first();
        let touches = [];
        if (clicked) touches = keep(await t.Touch.where({ visitorId: clicked.visitorId }).all(), input.at);
        if (!touches.length) touches = keep([await syntheticClickTouch(t, field, value, input.at, rules, input.isTest)], input.at);
        if (touches.length) return { touches, matchMethod: "click_id", reasonCode: null, session, booking, attributedAt: input.at };
    }

    // 6. nothing: Direct / unknown with the reason
    const reasonCode = firstReason ?? (sawCandidates ? "outside_lookback" : input.hasIdentifiers ? "no_tracked_visits" : "no_identifiers");
    return { touches: [], matchMethod: "none", reasonCode, session, booking, attributedAt: input.at };
}

/** After a write commits: mark the touched days stale for every instance (awaited), then notify. */
async function afterCommit(workspaceId, kind, instants, webhookEvents) {
    await noteWrite(workspaceId, instants.filter(Boolean).map(iso));
    for (const [type, data] of webhookEvents) dispatchWebhook(workspaceId, type, data);
}

// ─────────────────────────────────────────────────────────────────────────────
// Orders
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical order from a payload (API or connector). Throws IngestError(400) on bad input. */
export function normalizeOrderInput(body = {}) {
    const externalId = str(body.externalId, 200);
    if (!externalId) throw new IngestError(400, "externalId is required");
    if (!validDate(body.orderedAt)) throw new IngestError(400, "orderedAt must be an ISO timestamp");
    if (!isCurrencyCode(body.currency)) throw new IngestError(400, "currency must be a 3-character ISO code");
    const currency = body.currency.toUpperCase();
    const status = body.status ?? "paid";
    if (!ORDER_STATUSES.includes(status)) throw new IngestError(400, `status must be one of: ${ORDER_STATUSES.join(", ")}`);

    let gross, discount, tax, netGiven;
    try {
        gross = readMoney(body, "gross", currency, { required: true });
        discount = readMoney(body, "discount", currency);
        tax = readMoney(body, "tax", currency) ?? 0n;
        netGiven = readMoney(body, "net", currency);
    } catch (err) {
        if (err instanceof MoneyInputError) throw new IngestError(400, err.message);
        throw err;
    }
    if (body.taxIncluded === true) gross -= tax; // section 6: revenue excludes tax
    // Net revenue = gross - discounts (refunds are applied on their own date). A caller that only
    // sends gross + net gets the difference recorded as the discount.
    if (discount === null) discount = netGiven !== null && netGiven < gross ? gross - netGiven : 0n;
    const net = gross - discount;
    if (gross < 0n || discount < 0n || tax < 0n || net < 0n) throw new IngestError(400, "amounts cannot be negative (discount cannot exceed gross)");

    const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
    return {
        kind: "order",
        externalId,
        orderedAt: iso(body.orderedAt),
        currency,
        status,
        grossMinorUnits: gross,
        discountMinorUnits: discount,
        taxMinorUnits: tax,
        netMinorUnits: net,
        email: body.email ?? null,
        phone: body.phone ?? null,
        customerExternalId: str(body.customerExternalId ?? body.customerId, 200),
        customerExternalIdKey: str(body.customerExternalIdKey, 64),
        visitorId: str(body.visitorId, 200),
        checkoutToken: str(body.checkoutToken, 200),
        clickIds: readClickIds(body),
        bookingRef: body.bookingId || body.bookingExternalId ? { bookingId: body.bookingId ?? null, bookingExternalId: body.bookingExternalId ?? null } : null,
        items: items.map((it) => ({
            name: str(it.name, 300) || "Item",
            quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
            unitMinorUnits: readMoney(it, "unit", (it.currency || currency).toUpperCase()) ?? 0n,
            currency: isCurrencyCode(it.currency) ? it.currency.toUpperCase() : currency,
            externalId: str(it.externalId, 200),
        })),
    };
}

const orderResponse = (order, extra = {}) => ({
    id: order.id,
    orderId: order.id,
    externalId: order.externalId,
    customerId: order.customerId ?? null,
    connectorId: order.connectorId ?? null,
    locationId: order.locationId ?? null,
    bookingId: order.bookingId ?? null,
    status: order.status,
    matchMethod: order.matchMethod,
    attributionReason: order.attributionReason ?? null,
    isNewCustomer: order.isNewCustomer,
    currency: order.currency,
    grossMinorUnits: order.grossMinorUnits?.toString(),
    discountMinorUnits: order.discountMinorUnits?.toString(),
    netMinorUnits: order.netMinorUnits?.toString(),
    orderedAt: order.orderedAt,
    ...extra,
});

/**
 * @param {string} workspaceId     from the API key / connector — never from the body
 * @param {object} body            raw payload (API shape)
 * @param {{connectorId?, isTest?, receivedAt?, client?}} ctx
 * @returns {Promise<{statusCode: number, body: object}>}
 */
export async function ingestOrder(workspaceId, body, ctx = {}) {
    const client = ctx.client ?? db;
    const t = tenantDb(client, workspaceId);
    const input = normalizeOrderInput(body);

    const existing = await t.Order.where({ externalId: input.externalId }).first();
    if (existing) {
        const credits = await t.AttributionCredit.where({ orderId: existing.id }).all();
        return {
            statusCode: 200,
            body: orderResponse(existing, {
                status: "already_processed",
                orderStatus: existing.status,
                message: "Duplicate order — already ingested",
                touchIds: [...new Set(credits.map((c) => c.touchId).filter(Boolean))],
                attributionCreditIds: credits.map((c) => c.id),
            }),
        };
    }

    const ctxData = await loadWorkspaceContext(client, workspaceId);
    const locationId = await resolveLocationId(t, body);
    const booking = input.bookingRef ? await findBooking(t, input.bookingRef) : null;

    const { customer, matchedBy } = await resolveCustomer(client, workspaceId, {
        email: input.email,
        phone: input.phone,
        externalId: input.customerExternalId,
        externalIdKey: input.customerExternalIdKey || ctx.connectorType || "default",
    });
    // Payment webhooks often contain only the checkout token (gateway payloads do not
    // consistently include the buyer's email/phone). The SDK's identify call links the
    // checkout session's visitor to a Customer, so carry that identity onto the order.
    const checkoutSession = input.checkoutToken
        ? await t.CheckoutSession.where({ token: input.checkoutToken }).first().catch(() => null)
        : null;
    const sessionVisitor = checkoutSession?.visitorId
        ? await t.Visitor.where({ id: checkoutSession.visitorId }).first().catch(() => null)
        : null;
    const sessionCustomer = sessionVisitor?.customerId
        ? await t.Customer.where({ id: sessionVisitor.customerId }).first().catch(() => null)
        : null;
    const bookingCustomer = booking?.customerId
        ? await t.Customer.where({ id: booking.customerId }).first().catch(() => null)
        : null;
    const finalCustomer = customer ?? sessionCustomer ?? bookingCustomer;
    if (input.visitorId && finalCustomer) await linkVisitorToCustomer(client, workspaceId, input.visitorId, finalCustomer.id);

    const resolved = await resolveTouches(t, ctxData, {
        kind: "order",
        at: input.orderedAt,
        selfId: null,
        booking,
        customer: finalCustomer,
        matchedBy,
        visitorId: input.visitorId,
        checkoutToken: input.checkoutToken,
        clickIds: input.clickIds,
        isTest: Boolean(ctx.isTest),
        hasIdentifiers: Boolean(input.email || input.phone || input.customerExternalId || input.visitorId || input.checkoutToken || Object.keys(input.clickIds).length),
    });

    const reporting = ctxData.workspace.reportingCurrency || "USD";
    const fxRate = await findRate(client.orm.public, input.orderedAt.slice(0, 10), input.currency, reporting);
    const linkedBooking = resolved.booking ?? booking;

    let order;
    let credits = [];
    let items = [];
    try {
        ({ order, credits, items } = await client.transaction(async (tx) => {
            const tt = tenantDb(tx, workspaceId);
            const created = await tt.Order.create({
                locationId: locationId ?? linkedBooking?.locationId ?? null,
                customerId: finalCustomer?.id ?? null,
                externalId: input.externalId,
                connectorId: ctx.connectorId ?? null,
                bookingId: linkedBooking?.id ?? null,
                status: input.status,
                grossMinorUnits: input.grossMinorUnits,
                discountMinorUnits: input.discountMinorUnits,
                taxMinorUnits: input.taxMinorUnits,
                netMinorUnits: input.netMinorUnits,
                currency: input.currency,
                fxRateToReporting: fxRate,
                reportingCurrency: reporting,
                checkoutToken: input.checkoutToken,
                matchMethod: resolved.matchMethod,
                attributionReason: resolved.reasonCode,
                isNewCustomer: false,
                isTest: Boolean(ctx.isTest),
                idempotencyKey: str(body.idempotencyKey, 200) ?? input.externalId,
                // what the matching used, without personal data, so a re-run can repeat it
                rawPayload: { visitorId: input.visitorId, clickIds: input.clickIds, bookingRef: input.bookingRef },
                orderedAt: input.orderedAt,
            });

            const itemRows = [];
            for (const it of input.items) {
                itemRows.push(
                    await tx.orm.public.OrderItem.create({
                        orderId: created.id,
                        name: it.name,
                        quantity: it.quantity,
                        unitMinorUnits: it.unitMinorUnits,
                        totalMinorUnits: it.unitMinorUnits * BigInt(it.quantity),
                        currency: it.currency,
                        externalId: it.externalId,
                    }),
                );
            }

            if (resolved.session && resolved.matchMethod === "token" && !resolved.session.consumedOrderId) {
                await tt.CheckoutSession.where({ id: resolved.session.id }).update({ consumedAt: iso(input.orderedAt), consumedOrderId: created.id });
            }

            const creditRows = buildCreditRows({
                workspaceId,
                orderId: created.id,
                touches: resolved.touches,
                orderedAt: resolved.attributedAt,
                netMinorUnits: input.netMinorUnits,
                currency: input.currency,
                reasonCode: resolved.reasonCode ?? "no_source_found",
            });
            const creditRecords = [];
            for (const row of creditRows) creditRecords.push(await tt.AttributionCredit.create(row));

            // new vs returning is decided on the full paid history (handles out-of-order arrival)
            if (finalCustomer) await recomputeNewVsReturning(tx, workspaceId, finalCustomer.id);
            const fresh = await tt.Order.where({ id: created.id }).first();
            return { order: fresh ?? created, credits: creditRecords, items: itemRows };
        }));
    } catch (err) {
        // A concurrent delivery of the same order won the race: answer like a duplicate.
        if (err?.code === "23505") return ingestOrder(workspaceId, body, ctx);
        throw err;
    }

    const touchIds = [...new Set(resolved.touches.map((x) => x.id))];
    await afterCommit(workspaceId, "order", [order.orderedAt], [
        [
            "order.attributed",
            {
                orderId: order.id,
                externalId: order.externalId,
                status: order.status,
                currency: order.currency,
                netMinorUnits: order.netMinorUnits?.toString(),
                matchMethod: order.matchMethod,
                attributionReason: order.attributionReason ?? null,
                isNewCustomer: order.isNewCustomer,
                orderedAt: order.orderedAt,
                bookingId: order.bookingId ?? null,
                credits: credits
                    .filter((c) => c.model === ctxData.workspace.defaultModel)
                    .map((c) => ({ channel: c.channel, campaign: c.campaign, share: Number(c.share), amountMinorUnits: c.amountMinorUnits?.toString() })),
            },
        ],
    ]);

    let visitorRecordId = null;
    if (input.visitorId) visitorRecordId = (await t.Visitor.where({ visitorId: input.visitorId }).first())?.id ?? null;
    else if (resolved.session) visitorRecordId = resolved.session.visitorId;

    return {
        statusCode: 201,
        body: orderResponse(order, {
            visitorId: input.visitorId,
            visitorRecordId,
            checkoutSessionId: resolved.session?.id ?? null,
            touchIds,
            touchCount: touchIds.length,
            orderItemIds: items.map((i) => i.id),
            attributionCreditIds: credits.map((c) => c.id),
            fxRateToReporting: order.fxRateToReporting ?? null,
        }),
    };
}

/** PATCH an order: status changes (e.g. pending -> paid, paid -> voided). */
export async function updateOrderRecord(workspaceId, orderId, body, ctx = {}) {
    const client = ctx.client ?? db;
    const t = tenantDb(client, workspaceId);
    const order = await t.Order.where({ id: String(orderId) }).first().catch(() => null);
    if (!order) throw new IngestError(404, "Order not found", "not_found");
    const status = body?.status;
    if (!ORDER_STATUSES.includes(status)) throw new IngestError(400, `status must be one of: ${ORDER_STATUSES.join(", ")}`);
    if (["refunded", "partially_refunded"].includes(order.status) && status !== "voided") {
        throw new IngestError(409, "Refunded orders change through refunds", "conflict");
    }
    await client.transaction(async (tx) => {
        await tenantDb(tx, workspaceId).Order.where({ id: order.id }).update({ status });
        if (order.customerId) await recomputeNewVsReturning(tx, workspaceId, order.customerId);
    });
    await afterCommit(workspaceId, "order", [order.orderedAt], [["order.updated", { orderId: order.id, externalId: order.externalId, status }]]);
    return { statusCode: 200, body: { id: order.id, orderId: order.id, status, message: "Order updated" } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bookings — attributed when created, not when paid (scope 4.6)
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeBookingInput(body = {}, fallbackBookedAt) {
    const externalId = str(body.externalId, 200);
    if (!externalId) throw new IngestError(400, "externalId is required");
    if (!validDate(body.appointmentStartAt)) throw new IngestError(400, "appointmentStartAt must be an ISO timestamp");
    if (!isCurrencyCode(body.currency)) throw new IngestError(400, "currency must be a 3-character ISO code");
    const currency = body.currency.toUpperCase();
    const status = body.status ?? "scheduled";
    if (!BOOKING_STATUSES.includes(status)) throw new IngestError(400, `status must be one of: ${BOOKING_STATUSES.join(", ")}`);
    let bookedValue;
    try {
        bookedValue = readMoney(body, "bookedValue", currency) ?? 0n;
    } catch (err) {
        if (err instanceof MoneyInputError) throw new IngestError(400, err.message);
        throw err;
    }
    if (bookedValue < 0n) throw new IngestError(400, "bookedValue cannot be negative");
    if (body.bookedAt !== undefined && body.bookedAt !== null && !validDate(body.bookedAt)) throw new IngestError(400, "bookedAt must be an ISO timestamp");
    if (body.appointmentEndAt && !validDate(body.appointmentEndAt)) throw new IngestError(400, "appointmentEndAt must be an ISO timestamp");
    return {
        kind: "booking",
        externalId,
        appointmentStartAt: iso(body.appointmentStartAt),
        appointmentEndAt: body.appointmentEndAt ? iso(body.appointmentEndAt) : null,
        bookedAt: iso(body.bookedAt ?? fallbackBookedAt ?? new Date()),
        currency,
        status,
        bookedValueMinorUnits: bookedValue,
        serviceName: str(body.serviceName, 300),
        email: body.email ?? null,
        phone: body.phone ?? null,
        customerExternalId: str(body.customerExternalId ?? body.customerId, 200),
        customerExternalIdKey: str(body.customerExternalIdKey, 64),
        visitorId: str(body.visitorId, 200),
        checkoutToken: str(body.checkoutToken, 200),
        clickIds: readClickIds(body),
    };
}

const bookingResponse = (b, extra = {}) => ({
    id: b.id,
    bookingId: b.id,
    externalId: b.externalId,
    customerId: b.customerId ?? null,
    connectorId: b.connectorId ?? null,
    locationId: b.locationId ?? null,
    status: b.status,
    matchMethod: b.matchMethod,
    attributionReason: b.attributionReason ?? null,
    isNewCustomer: b.isNewCustomer,
    serviceName: b.serviceName ?? null,
    bookedValueMinorUnits: b.bookedValueMinorUnits?.toString(),
    currency: b.currency,
    appointmentStartAt: b.appointmentStartAt,
    bookedAt: b.bookedAt ?? b.createdAt,
    ...extra,
});

/** New guest = no earlier paid order and no earlier (non-cancelled) booking. */
async function isNewGuest(t, customerId, bookedAt, selfId) {
    if (!customerId) return false;
    const at = new Date(bookedAt);
    const orders = await t.Order.where({ customerId }).all();
    if (orders.some((o) => isPaidOrder(o) && new Date(o.orderedAt) < at)) return false;
    const bookings = await t.Booking.where({ customerId }).all();
    return !bookings.some((b) => b.id !== selfId && b.status !== "cancelled" && new Date(b.bookedAt ?? b.createdAt) < at);
}

export async function ingestBooking(workspaceId, body, ctx = {}) {
    const client = ctx.client ?? db;
    const t = tenantDb(client, workspaceId);
    const input = normalizeBookingInput(body, ctx.receivedAt);

    const existing = await t.Booking.where({ externalId: input.externalId }).first();
    if (existing) {
        // A repeated "created" event may carry changes (Zenoti re-sends on edit): apply them as an update.
        const changed =
            (input.status !== existing.status && body.status) ||
            iso(existing.appointmentStartAt) !== input.appointmentStartAt ||
            BigInt(existing.bookedValueMinorUnits ?? 0) !== input.bookedValueMinorUnits;
        if (changed && ctx.applyChanges) {
            return updateBookingRecord(workspaceId, existing.id, {
                status: body.status ?? undefined,
                appointmentStartAt: input.appointmentStartAt,
                bookedValueMinorUnits: input.bookedValueMinorUnits.toString(),
            }, ctx);
        }
        const credits = await t.AttributionCredit.where({ bookingId: existing.id }).all();
        return {
            statusCode: 200,
            body: bookingResponse(existing, {
                status: "already_processed",
                bookingStatus: existing.status,
                touchIds: [...new Set(credits.map((c) => c.touchId).filter(Boolean))],
                attributionCreditIds: credits.map((c) => c.id),
            }),
        };
    }

    const ctxData = await loadWorkspaceContext(client, workspaceId);
    const locationId = await resolveLocationId(t, body);
    const { customer, matchedBy } = await resolveCustomer(client, workspaceId, {
        email: input.email,
        phone: input.phone,
        externalId: input.customerExternalId,
        externalIdKey: input.customerExternalIdKey || ctx.connectorType || "default",
    });
    if (input.visitorId && customer) await linkVisitorToCustomer(client, workspaceId, input.visitorId, customer.id);

    // anchored at the moment the booking was made (not the appointment)
    const resolved = await resolveTouches(t, ctxData, {
        kind: "booking",
        at: input.bookedAt,
        selfId: null,
        customer,
        matchedBy,
        visitorId: input.visitorId,
        checkoutToken: input.checkoutToken,
        clickIds: input.clickIds,
        isTest: Boolean(ctx.isTest),
        hasIdentifiers: Boolean(input.email || input.phone || input.customerExternalId || input.visitorId || input.checkoutToken || Object.keys(input.clickIds).length),
    });
    const newGuest = await isNewGuest(t, customer?.id, input.bookedAt, null);

    let booking;
    let credits = [];
    let historyId = null;
    try {
        ({ booking, credits, historyId } = await client.transaction(async (tx) => {
            const tt = tenantDb(tx, workspaceId);
            const created = await tt.Booking.create({
                locationId,
                customerId: customer?.id ?? null,
                externalId: input.externalId,
                connectorId: ctx.connectorId ?? null,
                serviceName: input.serviceName,
                status: input.status,
                bookedValueMinorUnits: input.bookedValueMinorUnits,
                currency: input.currency,
                appointmentStartAt: input.appointmentStartAt,
                appointmentEndAt: input.appointmentEndAt,
                bookedAt: input.bookedAt,
                checkoutToken: input.checkoutToken,
                matchMethod: resolved.matchMethod,
                attributionReason: resolved.reasonCode,
                isNewCustomer: newGuest,
                isTest: Boolean(ctx.isTest),
                idempotencyKey: str(body.idempotencyKey, 200) ?? input.externalId,
                rawPayload: { visitorId: input.visitorId, clickIds: input.clickIds },
            });
            const history = await tx.orm.public.BookingStatusHistory.create({ bookingId: created.id, status: input.status, changedAt: input.bookedAt });
            if (resolved.session && resolved.matchMethod === "token" && !resolved.session.consumedBookingId) {
                await tt.CheckoutSession.where({ id: resolved.session.id }).update({ consumedAt: input.bookedAt, consumedBookingId: created.id });
            }
            const rows = buildCreditRows({
                workspaceId,
                bookingId: created.id,
                touches: resolved.touches,
                orderedAt: input.bookedAt,
                netMinorUnits: input.bookedValueMinorUnits,
                currency: input.currency,
                reasonCode: resolved.reasonCode ?? "no_source_found",
            });
            const records = [];
            for (const row of rows) records.push(await tt.AttributionCredit.create(row));
            return { booking: created, credits: records, historyId: history.id };
        }));
    } catch (err) {
        if (err?.code === "23505") return ingestBooking(workspaceId, body, ctx);
        throw err;
    }

    const touchIds = [...new Set(resolved.touches.map((x) => x.id))];
    await afterCommit(workspaceId, "booking", [booking.bookedAt], [
        [
            "booking.created",
            {
                bookingId: booking.id,
                externalId: booking.externalId,
                status: booking.status,
                bookedValueMinorUnits: booking.bookedValueMinorUnits?.toString(),
                currency: booking.currency,
                serviceName: booking.serviceName,
                appointmentStartAt: booking.appointmentStartAt,
                bookedAt: booking.bookedAt,
                matchMethod: booking.matchMethod,
                isNewCustomer: booking.isNewCustomer,
                locationId: booking.locationId,
                credits: credits
                    .filter((c) => c.model === ctxData.workspace.defaultModel)
                    .map((c) => ({ channel: c.channel, campaign: c.campaign, share: Number(c.share) })),
            },
        ],
    ]);

    let visitorRecordId = null;
    if (input.visitorId) visitorRecordId = (await t.Visitor.where({ visitorId: input.visitorId }).first())?.id ?? null;
    else if (resolved.session) visitorRecordId = resolved.session.visitorId;

    return {
        statusCode: 201,
        body: bookingResponse(booking, {
            visitorId: input.visitorId,
            visitorRecordId,
            checkoutSessionId: resolved.session?.id ?? null,
            touchIds,
            statusHistoryId: historyId,
            attributionCreditIds: credits.map((c) => c.id),
        }),
    };
}

/**
 * PATCH a booking: status, reschedule (appointmentStartAt), booked value, service, location.
 * Every status change is kept in BookingStatusHistory. Booked-value changes rescale the booking's
 * credits (same shares), so "booked value by source" stays consistent.
 */
export async function updateBookingRecord(workspaceId, bookingId, body = {}, ctx = {}) {
    const client = ctx.client ?? db;
    const t = tenantDb(client, workspaceId);
    const booking = await t.Booking.where({ id: String(bookingId) }).first().catch(() => null);
    if (!booking) throw new IngestError(404, "Booking not found", "not_found");

    const changes = {};
    let status = body.status;
    if (status !== undefined) {
        if (!BOOKING_STATUSES.includes(status)) throw new IngestError(400, `status must be one of: ${BOOKING_STATUSES.join(", ")}`);
        if (status !== booking.status) changes.status = status;
    }
    if (body.appointmentStartAt !== undefined) {
        if (!validDate(body.appointmentStartAt)) throw new IngestError(400, "appointmentStartAt must be an ISO timestamp");
        const next = iso(body.appointmentStartAt);
        if (next !== iso(booking.appointmentStartAt)) {
            changes.appointmentStartAt = next;
            if (!changes.status && !["cancelled", "completed", "no_show"].includes(booking.status)) {
                changes.status = "rescheduled";
                status = "rescheduled";
            }
        }
    }
    if (body.appointmentEndAt !== undefined) changes.appointmentEndAt = body.appointmentEndAt ? iso(body.appointmentEndAt) : null;
    if (body.serviceName !== undefined) changes.serviceName = str(body.serviceName, 300);
    let newValue = null;
    try {
        newValue = readMoney(body, "bookedValue", booking.currency);
    } catch (err) {
        throw new IngestError(400, err.message);
    }
    if (newValue !== null && newValue !== BigInt(booking.bookedValueMinorUnits ?? 0)) {
        if (newValue < 0n) throw new IngestError(400, "bookedValue cannot be negative");
        changes.bookedValueMinorUnits = newValue;
    }
    if (body.locationId !== undefined || body.locationExternalId !== undefined) {
        changes.locationId = await resolveLocationId(t, body);
    }
    if (!Object.keys(changes).length) {
        return { statusCode: 200, body: bookingResponse(booking, { message: "No changes" }) };
    }

    const historyId = await client.transaction(async (tx) => {
        const tt = tenantDb(tx, workspaceId);
        await tt.Booking.where({ id: booking.id }).update(changes);
        let hid = null;
        if (changes.status) {
            const h = await tx.orm.public.BookingStatusHistory.create({
                bookingId: booking.id,
                status: changes.status,
                reason: str(body.reason, 500),
                changedAt: body.changedAt && validDate(body.changedAt) ? iso(body.changedAt) : iso(ctx.receivedAt ?? new Date()),
            });
            hid = h.id;
        }
        if (changes.bookedValueMinorUnits !== undefined) await rescaleCredits(tt, { bookingId: booking.id }, changes.bookedValueMinorUnits);
        return hid;
    });

    const updated = await t.Booking.where({ id: booking.id }).first();
    const events = [["booking.updated", { bookingId: booking.id, externalId: booking.externalId, status: updated.status, changes: Object.keys(changes) }]];
    if (changes.status === "cancelled") events.push(["booking.cancelled", { bookingId: booking.id, externalId: booking.externalId, reason: str(body.reason, 500) }]);
    await afterCommit(workspaceId, "booking", [booking.bookedAt ?? booking.createdAt], events);
    return { statusCode: 200, body: bookingResponse(updated, { statusHistoryId: historyId, message: "Booking updated" }) };
}

/** Keep each model's shares, re-split a new total exactly. */
async function rescaleCredits(tt, where, newTotal) {
    const credits = await tt.AttributionCredit.where(where).all();
    const byModel = new Map();
    for (const c of credits) {
        if (!byModel.has(c.model)) byModel.set(c.model, []);
        byModel.get(c.model).push(c);
    }
    for (const rows of byModel.values()) {
        rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const amounts = allocateMinor(newTotal, rows.map((r) => Number(r.share)));
        for (let i = 0; i < rows.length; i++) await tt.AttributionCredit.where({ id: rows[i].id }).update({ amountMinorUnits: amounts[i] });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Refunds — counted on the refund date, linked to the original order (section 6)
// ─────────────────────────────────────────────────────────────────────────────

export async function ingestRefund(workspaceId, body = {}, ctx = {}) {
    const client = ctx.client ?? db;
    const t = tenantDb(client, workspaceId);
    if (!body.orderId && !body.externalOrderId) throw new IngestError(400, "orderId or externalOrderId is required");
    if (!isCurrencyCode(body.currency)) throw new IngestError(400, "currency must be a 3-char ISO code");
    if (body.refundedAt !== undefined && body.refundedAt !== null && !validDate(body.refundedAt)) throw new IngestError(400, "refundedAt must be an ISO timestamp");

    const order = body.orderId
        ? await t.Order.where({ id: String(body.orderId) }).first().catch(() => null)
        : await t.Order.where({ externalId: String(body.externalOrderId) }).first();
    // Not found yet: a connector refund can arrive before its payment. The queue retries it.
    if (!order) throw new IngestError(404, "Order not found", "order_not_found");

    const currency = body.currency.toUpperCase();
    if (currency !== order.currency) throw new IngestError(400, `Refund currency ${currency} does not match the order currency ${order.currency}`);

    const externalId = str(body.externalId, 200);
    const idempotencyKey = str(body.idempotencyKey, 200) ?? externalId;
    if (externalId || idempotencyKey) {
        const dup =
            (externalId && (await t.Refund.where({ externalId }).first())) ||
            (idempotencyKey && (await t.Refund.where({ idempotencyKey }).first()));
        if (dup) {
            return {
                statusCode: 200,
                body: { id: dup.id, refundId: dup.id, orderId: dup.orderId, externalOrderId: order.externalId, externalId: dup.externalId, orderStatus: order.status, status: "already_processed" },
            };
        }
    }

    let amount;
    try {
        amount = readMoney(body, "amount", currency, { required: true });
    } catch (err) {
        throw new IngestError(400, err.message);
    }
    if (amount <= 0n) throw new IngestError(400, "amount must be greater than zero");
    const already = BigInt(order.refundedMinorUnits ?? 0);
    const remaining = BigInt(order.netMinorUnits ?? 0) - already;
    if (amount > remaining) throw new IngestError(400, `Refund exceeds the refundable amount (${remaining} minor units left)`, "refund_exceeds_order");

    const refundedAt = iso(body.refundedAt ?? ctx.receivedAt ?? new Date());
    const total = already + amount;
    const newStatus = total >= BigInt(order.netMinorUnits ?? 0) ? "refunded" : "partially_refunded";

    const refund = await client.transaction(async (tx) => {
        const tt = tenantDb(tx, workspaceId);
        const created = await tt.Refund.create({
            orderId: order.id,
            amountMinorUnits: amount,
            currency,
            reason: str(body.reason, 500),
            externalId,
            idempotencyKey,
            refundedAt,
        });
        await tt.Order.where({ id: order.id }).update({ refundedMinorUnits: total, status: newStatus });
        return created;
    });

    await afterCommit(workspaceId, "refund", [refundedAt, order.orderedAt], [
        [
            "refund.created",
            {
                refundId: refund.id,
                orderId: order.id,
                externalOrderId: order.externalId,
                amountMinorUnits: amount.toString(),
                currency,
                orderStatus: newStatus,
                refundedAt,
            },
        ],
    ]);

    return {
        statusCode: 201,
        body: {
            id: refund.id,
            refundId: refund.id,
            orderId: order.id,
            externalOrderId: order.externalId,
            externalId: refund.externalId,
            amountMinorUnits: amount.toString(),
            currency,
            orderStatus: newStatus,
            refundedAt,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-run (settings change, customer merge, logic change)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recompute the credits of one order or booking from the stored inputs (token snapshot, booking
 * link, customer's visitors, visitor id, click ids). Touches are never modified, only credits.
 */
export async function reattribute(workspaceId, { orderId = null, bookingId = null }, ctx = {}) {
    const client = ctx.client ?? db;
    const t = tenantDb(client, workspaceId);
    const ctxData = ctx.ctxData ?? (await loadWorkspaceContext(client, workspaceId));
    const isOrder = Boolean(orderId);
    const rec = isOrder ? await t.Order.where({ id: orderId }).first() : await t.Booking.where({ id: bookingId }).first();
    if (!rec) return null;

    const stored = rec.rawPayload && typeof rec.rawPayload === "object" ? rec.rawPayload : {};
    const customer = rec.customerId ? await t.Customer.where({ id: rec.customerId }).first() : null;
    const booking = isOrder && rec.bookingId ? await t.Booking.where({ id: rec.bookingId }).first() : null;
    const at = isOrder ? rec.orderedAt : rec.bookedAt ?? rec.createdAt;

    const resolved = await resolveTouches(t, ctxData, {
        kind: isOrder ? "order" : "booking",
        at,
        selfId: rec.id,
        booking,
        customer,
        matchedBy: null,
        visitorId: stored.visitorId ?? null,
        checkoutToken: rec.checkoutToken,
        clickIds: stored.clickIds ?? {},
        isTest: Boolean(rec.isTest),
        hasIdentifiers: Boolean(customer || stored.visitorId || rec.checkoutToken || Object.keys(stored.clickIds ?? {}).length),
    });

    const amount = isOrder ? rec.netMinorUnits : rec.bookedValueMinorUnits;
    const rows = buildCreditRows({
        workspaceId,
        orderId: isOrder ? rec.id : null,
        bookingId: isOrder ? null : rec.id,
        touches: resolved.touches,
        orderedAt: resolved.attributedAt,
        netMinorUnits: amount,
        currency: rec.currency,
        reasonCode: resolved.reasonCode ?? "no_source_found",
    });

    await client.transaction(async (tx) => {
        const tt = tenantDb(tx, workspaceId);
        await tt.AttributionCredit.where(isOrder ? { orderId: rec.id } : { bookingId: rec.id }).delete();
        for (const row of rows) await tt.AttributionCredit.create(row);
        const patch = { matchMethod: resolved.matchMethod, attributionReason: resolved.reasonCode };
        if (isOrder) await tt.Order.where({ id: rec.id }).update(patch);
        else await tt.Booking.where({ id: rec.id }).update(patch);
    });
    return { id: rec.id, matchMethod: resolved.matchMethod, reasonCode: resolved.reasonCode, touchCount: resolved.touches.length };
}

/** Re-run every order and booking of a company (optionally only those in [from, to]). */
export async function reattributeWorkspace(workspaceId, { from = null, to = null, client = db } = {}) {
    const t = tenantDb(client, workspaceId);
    const ctxData = await loadWorkspaceContext(client, workspaceId);
    // credits are about to change: reports compute live until the rollups are rebuilt
    await invalidateRollups(workspaceId, client);

    // Persist channels under the current rules so journeys and reports agree with the credits.
    const touches = await t.Touch.all();
    for (const touch of touches) {
        const channel = classifyChannel(touch, ctxData.rules);
        if (channel !== touch.channel) await t.Touch.where({ id: touch.id }).update({ channel });
    }

    const inRange = (v) => (!from || new Date(v) >= new Date(from)) && (!to || new Date(v) <= new Date(to));
    const bookings = (await t.Booking.all()).filter((b) => inRange(b.bookedAt ?? b.createdAt));
    const orders = (await t.Order.all()).filter((o) => inRange(o.orderedAt));
    // bookings first: invoices inherit from them
    let count = 0;
    for (const b of bookings) {
        await reattribute(workspaceId, { bookingId: b.id }, { client, ctxData });
        count++;
    }
    for (const o of orders) {
        await reattribute(workspaceId, { orderId: o.id }, { client, ctxData });
        count++;
    }
    return { reattributed: count, orders: orders.length, bookings: bookings.length };
}

/** Connector helper: update a booking known only by the source system's id. 404 when unknown. */
export async function updateBookingByExternalId(workspaceId, externalId, body, ctx = {}) {
    const client = ctx.client ?? db;
    const booking = await tenantDb(client, workspaceId).Booking.where({ externalId: String(externalId) }).first();
    if (!booking) throw new IngestError(404, `Booking ${externalId} not found`, "booking_not_found");
    const clean = Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) => v !== undefined && v !== null));
    return (await updateBookingRecord(workspaceId, booking.id, clean, ctx)).body;
}
