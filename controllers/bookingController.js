/**
 * Booking ingestion and lifecycle updates.
 * A booking follows the same identity and attribution pipeline as an order, but is attributed when created.
 * Dashboard requests use req.user; public API requests use the workspace resolved by API-key middleware.
 */

/**
 * Bookings Controller  —  POST /v1/bookings  |  PATCH /v1/bookings/:id
 *
 * Same attribution pipeline as orders, but for bookings.
 * Bookings are attributed at creation time, not payment time.
 *
 * POST Body:
 *   externalId*          - booking system's ID
 *   appointmentStartAt*  - ISO timestamp of appointment
 *   currency*            - ISO 4217
 *   bookedValue*         - service price at booking (major units)
 *   checkoutToken?       - token from /v1/checkout-sessions
 *   visitorId?           - client-side visitor ID fallback
 *   email?               - customer email
 *   phone?               - customer phone
 *   locationId?          - workspace location ID
 *   serviceName?         - service booked
 *   appointmentEndAt?    - ISO timestamp
 *   connectorId?         - connector that sent this
 *   idempotencyKey?
 *
 * PATCH Body:
 *   status? - new BookingStatus value
 *   reason? - reason for status change
 */

import { db } from "../src/prisma/db.js";
import { resolveListWindow } from "./reportsController.js";
import { resolveOrCreateCustomer, getVisitorTouches, linkVisitorToCustomer } from "../services/identityService.js";
import { filterTouches, buildCreditRows } from "../services/attributionEngine.js";
import { dispatchWebhook } from "../services/webhookDispatcher.js";
import { writeAudit } from "../services/audit.js";

const toMinorUnits = (amount, decimals = 2) => BigInt(Math.round(Number(amount) * Math.pow(10, decimals)));

const VALID_STATUSES = ["scheduled", "confirmed", "completed", "cancelled", "rescheduled", "no_show"];

export const createBooking = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;

        const {
            externalId,
            appointmentStartAt,
            currency,
            bookedValue = 0,
            checkoutToken,
            visitorId,
            email,
            phone,
            locationId,
            serviceName,
            appointmentEndAt,
            connectorId,
            idempotencyKey,
        } = req.body ?? {};

        if (!externalId) return res.status(400).json({ message: "externalId is required" });
        if (!appointmentStartAt) return res.status(400).json({ message: "appointmentStartAt is required" });
        if (!currency || currency.length !== 3) return res.status(400).json({ message: "currency must be a 3-char ISO code" });

        // Idempotency check
        const existing = await db.orm.public.Booking.where({ workspaceId, externalId }).first();
        if (existing) {
            const [credits, session] = await Promise.all([
                db.orm.public.AttributionCredit.where({ bookingId: existing.id }).all(),
                existing.checkoutToken
                    ? db.orm.public.CheckoutSession.where({ workspaceId, token: existing.checkoutToken }).first()
                    : null,
            ]);
            const visitor = visitorId
                ? await db.orm.public.Visitor.where({ workspaceId, visitorId }).first()
                : session
                    ? await db.orm.public.Visitor.where({ id: session.visitorId, workspaceId }).first()
                    : null;
            return res.status(200).json({
                id: existing.id,
                bookingId: existing.id,
                externalId: existing.externalId,
                customerId: existing.customerId,
                visitorId: visitor?.visitorId ?? visitorId ?? null,
                visitorRecordId: visitor?.id ?? null,
                connectorId: existing.connectorId,
                locationId: existing.locationId,
                checkoutSessionId: session?.id ?? null,
                touchIds: [...new Set(credits.map((credit) => credit.touchId).filter(Boolean))],
                attributionCreditIds: credits.map((credit) => credit.id),
                status: "already_processed",
            });
        }

        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();

        // Identity resolution
        const { customer, isNew: isNewCustomer } = await resolveOrCreateCustomer(db, workspaceId, { email, phone });
        if (visitorId) await linkVisitorToCustomer(db, workspaceId, visitorId, customer.id);

        // Touch resolution — same waterfall as orders
        let touches = [];
        let matchMethod = "none";
        let checkoutSessionId = null;
        let resolvedVisitor = visitorId
            ? await db.orm.public.Visitor.where({ workspaceId, visitorId }).first()
            : null;

        if (checkoutToken) {
            const session = await db.orm.public.CheckoutSession.where({ token: checkoutToken, workspaceId }).first();
            checkoutSessionId = session?.id ?? null;
            if (session && !resolvedVisitor) {
                resolvedVisitor = await db.orm.public.Visitor.where({
                    id: session.visitorId,
                    workspaceId,
                }).first();
            }
            if (session && !session.consumedAt && new Date(session.expiresAt) > new Date()) {
                const touchIds = (session.frozenTouches || []).map(t => t.id).filter(Boolean);
                if (touchIds.length > 0) {
                    const allTouches = await db.orm.public.Touch.where({ visitorId: session.visitorId }).all();
                    touches = allTouches.filter(t => touchIds.includes(t.id));
                }
                matchMethod = "token";
            }
        }

        if (touches.length === 0 && (email || phone) && customer) {
            const visitors = await db.orm.public.Visitor.where({ workspaceId, customerId: customer.id }).all();
            for (const v of visitors) {
                const vTouches = await db.orm.public.Touch.where({ visitorId: v.id }).all();
                touches.push(...vTouches);
            }
            if (touches.length > 0) matchMethod = email ? "email" : "phone";
        }

        if (touches.length === 0 && visitorId) {
            touches = await getVisitorTouches(workspaceId, visitorId);
            if (touches.length > 0) matchMethod = "click_id";
        }

        const lookbackDays = workspace?.lookbackDays || 30;
        touches = filterTouches(touches, lookbackDays, appointmentStartAt, workspace?.lookbackOverrides || {});

        // Is new customer?
        const priorBookings = customer
            ? await db.orm.public.Booking.where({ workspaceId, customerId: customer.id }).all()
            : [];
        const customerIsNew = priorBookings.filter(b => new Date(b.createdAt) < new Date()).length === 0;

        const bookedValueMinorUnits = toMinorUnits(bookedValue);

        const creditRows = buildCreditRows({
            workspaceId,
            bookingId: null, // filled below
            touches,
            orderedAt: appointmentStartAt,
            netMinorUnits: bookedValueMinorUnits,
            currency,
        });

        const result = await db.transaction(async (tx) => {
            const booking = await tx.orm.public.Booking.create({
                workspaceId,
                locationId: locationId ?? null,
                customerId: customer?.id ?? null,
                externalId,
                connectorId: connectorId ?? null,
                serviceName: serviceName ?? null,
                status: "scheduled",
                bookedValueMinorUnits,
                currency: currency.toUpperCase(),
                appointmentStartAt: new Date(appointmentStartAt).toISOString(),
                appointmentEndAt: appointmentEndAt ? new Date(appointmentEndAt).toISOString() : null,
                checkoutToken: checkoutToken ?? null,
                matchMethod,
                isNewCustomer: customerIsNew,
                idempotencyKey: idempotencyKey || externalId,
            });

            // Initial status history
            const statusHistory = await tx.orm.public.BookingStatusHistory.create({
                bookingId: booking.id,
                status: "scheduled",
            });

            // Mark checkout session consumed
            if (checkoutToken) {
                const session = await tx.orm.public.CheckoutSession.where({ token: checkoutToken, workspaceId }).first();
                if (session) {
                    checkoutSessionId = session.id;
                    await tx.orm.public.CheckoutSession.where({ id: session.id }).update({
                        consumedAt: new Date().toISOString(),
                        consumedOrderId: booking.id, // reusing the field for bookings too
                    });
                }
            }

            // Attribution credits
            const attributionCredits = [];
            for (const row of creditRows) {
                attributionCredits.push(
                    await tx.orm.public.AttributionCredit.create({ ...row, bookingId: booking.id, orderId: null })
                );
            }

            await writeAudit(tx.orm.public, {
                workspaceId,
                actorType: "api_key",
                actorUserId: null,
                action: "booking.created",
                targetType: "booking",
                targetId: booking.id,
                metadata: { externalId, matchMethod, isNewCustomer: customerIsNew, touchCount: touches.length },
                ip: req.ip ?? null,
                userAgent: req.headers["user-agent"] ?? null,
            });

            return { booking, statusHistoryId: statusHistory.id, attributionCredits };
        });

        const booking = result.booking;

        // Dispatch outbound webhook (fire-and-forget)
        dispatchWebhook(workspaceId, "booking.created", {
            bookingId: booking.id,
            externalId: booking.externalId,
            status: booking.status,
            bookedValueMinorUnits: booking.bookedValueMinorUnits?.toString(),
            currency: booking.currency,
            serviceName: booking.serviceName,
            appointmentStartAt: booking.appointmentStartAt,
            matchMethod,
            isNewCustomer: customerIsNew,
            customerId: booking.customerId,
            locationId: booking.locationId,
        });

        return res.status(201).json({
            id: booking.id,
            bookingId: booking.id,
            externalId: booking.externalId,
            customerId: booking.customerId,
            visitorId: resolvedVisitor?.visitorId ?? visitorId ?? null,
            visitorRecordId: resolvedVisitor?.id ?? null,
            connectorId: booking.connectorId,
            locationId: booking.locationId,
            checkoutSessionId,
            touchIds: [...new Set(touches.map((touch) => touch.id))],
            statusHistoryId: result.statusHistoryId,
            attributionCreditIds: result.attributionCredits.map((credit) => credit.id),
            status: booking.status,
            matchMethod,
            isNewCustomer: customerIsNew,
        });
    } catch (error) {
        console.error("createBooking error:", error.message);
        return res.status(500).json({ message: "Internal server error while ingesting booking" });
    }
};

/**
 * PATCH /v1/bookings/:id
 * Update booking status (confirmed, completed, cancelled, rescheduled, no_show)
 */
export const updateBooking = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;
        const booking = await db.orm.public.Booking.where({ id: req.params.id, workspaceId }).first();
        if (!booking) return res.status(404).json({ message: "Booking not found" });

        const { status, reason } = req.body ?? {};
        if (!status) return res.status(400).json({ message: "status is required" });
        if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({ message: `status must be one of: ${VALID_STATUSES.join(", ")}` });
        }

        const statusHistory = await db.transaction(async (tx) => {
            await tx.orm.public.Booking.where({ id: booking.id }).update({ status });
            return tx.orm.public.BookingStatusHistory.create({
                bookingId: booking.id,
                status,
                reason: reason ?? null,
            });
        });

        // Dispatch outbound webhook
        dispatchWebhook(workspaceId, "booking.updated", {
            bookingId: booking.id,
            externalId: booking.externalId,
            status,
            reason: reason ?? null,
        });

        return res.status(200).json({
            id: booking.id,
            bookingId: booking.id,
            statusHistoryId: statusHistory.id,
            message: "Booking updated",
            status,
        });
    } catch (error) {
        console.error("updateBooking error:", error.message);
        return res.status(500).json({ message: "Internal server error while updating booking" });
    }
};

/**
 * GET /v1/bookings — list bookings
 */
export const listBookings = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        const offset = (page - 1) * limit;

        let query = db.orm.public.Booking.where((b) => b.workspaceId.eq(workspaceId));

        if (req.query.status) {
            query = query.where((b) => b.status.eq(req.query.status));
        }
        if (req.query.locationId) {
            query = query.where((b) => b.locationId.eq(req.query.locationId));
        }
        const { fromIso, toIso } = await resolveListWindow(req, workspaceId);
        if (fromIso) query = query.where((b) => b.appointmentStartAt.gte(fromIso));
        if (toIso) query = query.where((b) => b.appointmentStartAt.lte(toIso));

        const countResult = await query.aggregate((agg) => ({ total: agg.count() }));
        const total = countResult?.total || 0;

        const bookings = await query
            .orderBy((b) => b.appointmentStartAt.desc())
            .limit(limit)
            .offset(offset)
            .all();

        const data = bookings.map((b) => ({
            id: b.id,
            externalId: b.externalId,
            status: b.status,
            currency: b.currency,
            bookedValueMinorUnits: b.bookedValueMinorUnits?.toString(),
            serviceName: b.serviceName,
            matchMethod: b.matchMethod,
            isNewCustomer: b.isNewCustomer,
            locationId: b.locationId,
            customerId: b.customerId,
            appointmentStartAt: b.appointmentStartAt,
            createdAt: b.createdAt,
        }));

        return res.status(200).json({
            data,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    } catch (error) {
        if (error?.statusCode === 400) return res.status(400).json({ message: error.message });
        console.error("listBookings error:", error.message);
        return res.status(500).json({ message: "Internal server error while listing bookings" });
    }
};

/**
 * GET /v1/bookings/upcoming — bookings in the next N days
 */
export const listUpcomingBookings = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;
        const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 7));
        const now = new Date();
        const until = new Date(now.getTime() + days * 86400 * 1000);

        let bookings = await db.orm.public.Booking.where({ workspaceId }).all();
        bookings = bookings.filter(b =>
            ["scheduled", "confirmed"].includes(b.status) &&
            new Date(b.appointmentStartAt) >= now &&
            new Date(b.appointmentStartAt) <= until
        );
        if (req.query.locationId) bookings = bookings.filter(b => b.locationId === req.query.locationId);

        bookings.sort((a, b) => String(a.appointmentStartAt).localeCompare(String(b.appointmentStartAt)));

        return res.status(200).json({
            data: bookings.map(b => ({
                id: b.id,
                externalId: b.externalId,
                status: b.status,
                serviceName: b.serviceName,
                bookedValueMinorUnits: b.bookedValueMinorUnits?.toString(),
                currency: b.currency,
                locationId: b.locationId,
                customerId: b.customerId,
                appointmentStartAt: b.appointmentStartAt,
            })),
            count: bookings.length,
            days,
        });
    } catch (error) {
        console.error("listUpcomingBookings error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};
