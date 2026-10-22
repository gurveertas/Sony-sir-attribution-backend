/**
 * Customers Controller  —  GET /v1/customers  |  GET /v1/customers/:id/journey
 *
 * Customer and attribution journey endpoints are shared by the API-key and
 * cookie-authenticated workspace routes. Email is returned only to user sessions.
 */

import { db } from "../src/prisma/db.js";
import { decryptSecret } from "../utils/crypto.js";
import { MergeError, mergeCustomers } from "../services/customerMerge.js";

const serializeCustomer = (customer, includeEmail) => ({
    id: customer.id,
    ...(includeEmail ? { email: customer.emailEnc ? decryptSecret(customer.emailEnc) : null } : {}),
    firstSeenAt: customer.firstSeenAt,
    firstPurchaseAt: customer.firstPurchaseAt ?? null,
    lastPurchaseAt: customer.lastPurchaseAt ?? null,
    externalIds: customer.externalIds ?? null,
});

/**
 * GET /v1/customers or /api/workspace/customers — list workspace customers
 */
export const listCustomers = async (req, res, WID) => {
    try {
        const workspaceId = req.workspaceId || WID;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        const offset = (page - 1) * limit;
        // platform admins in a support session see masked data unless the session explicitly unmasked PII
        const includeEmail = Boolean(req.user) && !req.maskPii;

        // Base query: only non-merged customers for this workspace
        let query = db.orm.public.Customer
            .where((c) => c.workspaceId.eq(workspaceId))
            .where((c) => c.mergedIntoId.isNull());

        // Fast-path: database-level pagination (avoids loading all customers into memory)
        if (!req.query.externalId || !req.query.externalIdKey) {
            const countResult = await query.aggregate((agg) => ({ total: agg.count() }));
            const total = countResult?.total || 0;

            const customers = await query
                .orderBy((c) => c.firstSeenAt.desc())
                .limit(limit)
                .offset(offset)
                .all();

            const data = customers.map((customer) => serializeCustomer(customer, includeEmail));

            return res.status(200).json({
                data,
                pagination: { page, limit, total, pages: Math.ceil(total / limit) },
            });
        }

        // Filter by external ID JSON property if specified
        let customers = await query.all();
        const extKey = req.query.externalIdKey;
        const extVal = req.query.externalId;
        customers = customers.filter((c) => {
            try {
                const ext = c.externalIds || {};
                return ext[extKey] === extVal;
            } catch {
                return false;
            }
        });

        customers.sort((a, b) => String(b.firstSeenAt).localeCompare(String(a.firstSeenAt)));
        const total = customers.length;
        const data = customers
            .slice(offset, offset + limit)
            .map((customer) => serializeCustomer(customer, includeEmail));

        return res.status(200).json({
            data,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error("listCustomers error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET /v1/customers/:id/journey — full attribution journey for a customer
 *
 * Returns:
 *   - all touches (timeline)
 *   - all orders with attribution credits
 *   - all bookings with attribution credits
 *   - all refunds
 */
export const getCustomerJourney = async (req, res) => {
    try {
        const userWorkspaceId = req.workspaceId || req.user?.workspaceId;
        const customerQuery = db.orm.public.Customer.where({ id: req.params.id });
        const customer = userWorkspaceId
            ? await customerQuery.where({ workspaceId: userWorkspaceId }).first()
            : req.user?.role === "platform_admin"
                ? await customerQuery.first()
                : null;
        if (!customer) return res.status(404).json({ message: "Customer not found" });
        const workspaceId = customer.workspaceId;

        // Get all visitors linked to this customer
        const visitors = await db.orm.public.Visitor.where({ workspaceId, customerId: customer.id }).all();
        const visitorIds = visitors.map(v => v.id);

        // Get touches across all visitors
        let touches = [];
        for (const vid of visitorIds) {
            const vTouches = await db.orm.public.Touch.where({ visitorId: vid }).all();
            touches.push(...vTouches);
        }
        touches.sort((a, b) => String(a.touchedAt).localeCompare(String(b.touchedAt)));

        // Get orders, bookings, refunds
        const orders = await db.orm.public.Order.where({ workspaceId, customerId: customer.id }).all();
        const bookings = await db.orm.public.Booking.where({ workspaceId, customerId: customer.id }).all();

        let refunds = [];
        for (const order of orders) {
            const r = await db.orm.public.Refund.where({ orderId: order.id }).all();
            refunds.push(...r);
        }

        // Get attribution credits grouped by model (default model or query param)
        const model = req.query.model || "last_non_direct";
        let orderCredits = [];
        let bookingCredits = [];
        for (const order of orders) {
            const credits = await db.orm.public.AttributionCredit.where({ orderId: order.id, model }).all();
            orderCredits.push(...credits.map(c => ({ ...c, orderId: order.id })));
        }
        for (const booking of bookings) {
            const credits = await db.orm.public.AttributionCredit.where({ bookingId: booking.id, model }).all();
            bookingCredits.push(...credits.map(c => ({ ...c, bookingId: booking.id })));
        }

        return res.status(200).json({
            customer: {
                id: customer.id,
                ...(req.user && !req.maskPii
                    ? { email: customer.emailEnc ? decryptSecret(customer.emailEnc) : null }
                    : {}),
                firstSeenAt: customer.firstSeenAt,
                firstPurchaseAt: customer.firstPurchaseAt ?? null,
                lastPurchaseAt: customer.lastPurchaseAt ?? null,
                externalIds: customer.externalIds ?? null,
            },
            touches: touches.map(t => ({
                id: t.id,
                channel: t.channel,
                source: t.source,
                medium: t.medium,
                campaign: t.campaign,
                referrer: t.referrer,
                landingPage: t.landingPage,
                gclid: t.gclid,
                fbclid: t.fbclid,
                touchedAt: t.touchedAt,
            })),
            orders: orders.map(o => ({
                id: o.id,
                externalId: o.externalId,
                status: o.status,
                currency: o.currency,
                netMinorUnits: o.netMinorUnits?.toString(),
                matchMethod: o.matchMethod,
                isNewCustomer: o.isNewCustomer,
                orderedAt: o.orderedAt,
                credits: orderCredits.filter(c => c.orderId === o.id).map(c => ({
                    touchId: c.touchId,
                    share: c.share,
                    amountMinorUnits: c.amountMinorUnits?.toString(),
                })),
            })),
            bookings: bookings.map(b => ({
                id: b.id,
                externalId: b.externalId,
                status: b.status,
                currency: b.currency,
                bookedValueMinorUnits: b.bookedValueMinorUnits?.toString(),
                serviceName: b.serviceName,
                matchMethod: b.matchMethod,
                appointmentStartAt: b.appointmentStartAt,
                credits: bookingCredits.filter(c => c.bookingId === b.id).map(c => ({
                    touchId: c.touchId,
                    share: c.share,
                    amountMinorUnits: c.amountMinorUnits?.toString(),
                })),
            })),
            refunds: refunds.map(r => ({
                id: r.id,
                orderId: r.orderId,
                amountMinorUnits: r.amountMinorUnits?.toString(),
                currency: r.currency,
                reason: r.reason,
                refundedAt: r.refundedAt,
            })),
            touchCount: touches.length,
            attributionModel: model,
        });
    } catch (error) {
        console.error("getCustomerJourney error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};


/**
 * POST /api/workspace/customers/merge   (company_admin)
 * Body: { sourceId, targetId }
 *
 * Merges two customer records of the same company (e.g. the same person created twice by two systems).
 * Visitors/touches, orders and bookings move to the target, and new-vs-returning is recomputed.
 */
export const mergeCustomersHandler = async (req, res) => {
    try {
        const { sourceId, targetId } = req.body ?? {};
        const result = await mergeCustomers(db, {
            workspaceId: req.user.workspaceId,
            sourceId,
            targetId,
            actorUserId: req.user.id,
            ip: req.ip,
            userAgent: req.headers["user-agent"],
        });
        return res.status(200).json(result);
    } catch (error) {
        if (error instanceof MergeError) {
            return res.status(error.statusCode).json({ code: error.code, message: error.message });
        }
        console.error("mergeCustomers error:", error.message);
        return res.status(500).json({ message: "Internal server error" });
    }
};
