import { writeAudit } from "./audit.js";
/**
 * Customer merge + new-vs-returning recomputation.
 *
 * Metric definition (single source of truth): a customer is NEW on an order when that order is their
 * first PAID order in the company, judged by order timestamp after identity resolution. An order that
 * was later partially/fully refunded was still a paid order, so it keeps counting as "earlier".
 */

/** Statuses that represent an order that was paid at some point. */
export const PAID_ORDER_STATUSES = ["paid", "partially_refunded", "refunded"];

export const isPaidOrder = (order) => PAID_ORDER_STATUSES.includes(order.status);

/**
 * Recomputes isNewCustomer on every paid order of a customer plus the customer's first/last purchase dates.
 * @returns {{changed: number, firstPurchaseAt: string|null, lastPurchaseAt: string|null}}
 */
export async function recomputeNewVsReturning(tx, workspaceId, customerId) {
    const orm = tx.orm.public;
    const orders = await orm.Order.where({ workspaceId, customerId }).all();
    const paid = orders
        .filter(isPaidOrder)
        .sort((a, b) => new Date(a.orderedAt) - new Date(b.orderedAt) || String(a.id).localeCompare(String(b.id)));

    let changed = 0;
    for (const [index, order] of paid.entries()) {
        const shouldBeNew = index === 0;
        if (Boolean(order.isNewCustomer) !== shouldBeNew) {
            await orm.Order.where({ id: order.id }).update({ isNewCustomer: shouldBeNew });
            changed++;
        }
    }

    const firstPurchaseAt = paid[0]?.orderedAt ?? null;
    const lastPurchaseAt = paid.at(-1)?.orderedAt ?? null;
    await orm.Customer.where({ id: customerId }).update({ firstPurchaseAt, lastPurchaseAt });
    return { changed, firstPurchaseAt, lastPurchaseAt };
}

export class MergeError extends Error {
    constructor(status, message, code) {
        super(message);
        this.statusCode = status;
        this.code = code;
    }
}

/**
 * Merges `source` into `target` inside one transaction:
 *  - visitors (and through them every touch), orders and bookings move to the target
 *  - identifiers the target lacks (email/phone hash, encrypted email, external ids) are carried over
 *  - the source is kept as a tombstone (mergedIntoId) so history and external references stay resolvable
 *  - new-vs-returning flags and purchase dates are recomputed over the combined order history
 */
export async function mergeCustomers(db, { workspaceId, sourceId, targetId, actorUserId, ip, userAgent }) {
    if (!sourceId || !targetId) throw new MergeError(400, "sourceId and targetId are required", "validation_error");
    if (sourceId === targetId) throw new MergeError(400, "A customer cannot be merged into itself", "validation_error");

    return db.transaction(async (tx) => {
        const orm = tx.orm.public;
        const [source, target] = await Promise.all([
            orm.Customer.where({ id: sourceId, workspaceId }).first(),
            orm.Customer.where({ id: targetId, workspaceId }).first(),
        ]);
        if (!source || !target) throw new MergeError(404, "Customer not found", "not_found");
        if (source.mergedIntoId) throw new MergeError(409, "The source customer was already merged into another customer", "already_merged");
        if (target.mergedIntoId) throw new MergeError(409, "The target customer was merged into another customer — merge into the surviving customer instead", "target_merged");

        const [movedOrders, movedBookings, movedVisitors] = await Promise.all([
            orm.Order.where({ workspaceId, customerId: source.id }).all(),
            orm.Booking.where({ workspaceId, customerId: source.id }).all(),
            orm.Visitor.where({ workspaceId, customerId: source.id }).all(),
        ]);

        await orm.Order.where({ workspaceId, customerId: source.id }).update({ customerId: target.id });
        await orm.Booking.where({ workspaceId, customerId: source.id }).update({ customerId: target.id });
        await orm.Visitor.where({ workspaceId, customerId: source.id }).update({ customerId: target.id });

        const carried = {};
        for (const field of ["emailHash", "emailEnc", "phoneHash"]) {
            if (!target[field] && source[field]) carried[field] = source[field];
        }
        // target wins on conflicting external ids
        const externalIds = { ...(source.externalIds ?? {}), ...(target.externalIds ?? {}) };
        if (Object.keys(externalIds).length) carried.externalIds = externalIds;
        if (source.firstSeenAt && (!target.firstSeenAt || new Date(source.firstSeenAt) < new Date(target.firstSeenAt))) {
            carried.firstSeenAt = source.firstSeenAt;
        }
        if (Object.keys(carried).length) await orm.Customer.where({ id: target.id }).update(carried);

        await orm.Customer.where({ id: source.id }).update({ mergedIntoId: target.id });

        const recomputed = await recomputeNewVsReturning(tx, workspaceId, target.id);

        await writeAudit(orm, {
            workspaceId,
            actorType: actorUserId ? "user" : "api_key",
            actorUserId: actorUserId ?? null,
            action: "customer.merged",
            targetType: "customer",
            targetId: target.id,
            metadata: {
                sourceId: source.id,
                targetId: target.id,
                orders: movedOrders.length,
                bookings: movedBookings.length,
                visitors: movedVisitors.length,
                newVsReturningFlagsChanged: recomputed.changed,
            },
            ip: ip ?? null,
            userAgent: userAgent ?? null,
        });

        return {
            targetId: target.id,
            sourceId: source.id,
            moved: { orders: movedOrders.length, bookings: movedBookings.length, visitors: movedVisitors.length },
            newVsReturningFlagsChanged: recomputed.changed,
            firstPurchaseAt: recomputed.firstPurchaseAt,
            lastPurchaseAt: recomputed.lastPurchaseAt,
        };
    });
}
