/**
 * Refunds Controller  —  POST /v1/refunds
 *
 * Records a refund, links it to the original order, and updates
 * the order's refundedMinorUnits + status.
 *
 * Body:
 *   orderId*         - internal order ID (or use externalOrderId)
 *   externalOrderId? - your system's order ID (alternative lookup)
 *   amount*          - refund amount (major units)
 *   currency*        - ISO 4217 (must match order)
 *   reason?          - refund reason
 *   externalId?      - refund system ID
 *   refundedAt?      - ISO timestamp (defaults to now)
 *   idempotencyKey?  - dedup key
 */

import { db } from "../src/prisma/db.js";
import { dispatchWebhook } from "../services/webhookDispatcher.js";
import { writeAudit } from "../services/audit.js";

const toMinorUnits = (amount) => BigInt(Math.round(Number(amount) * 100));

export const createRefund = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;
        const {
            orderId,
            externalOrderId,
            amount,
            currency,
            reason,
            externalId,
            refundedAt,
            idempotencyKey,
        } = req.body ?? {};

        if (!orderId && !externalOrderId) return res.status(400).json({ message: "orderId or externalOrderId is required" });
        if (amount === undefined) return res.status(400).json({ message: "amount is required" });
        if (!currency || currency.length !== 3) return res.status(400).json({ message: "currency must be a 3-char ISO code" });

        // Look up the order
        let order;
        if (orderId) {
            order = await db.orm.public.Order.where({ id: orderId, workspaceId }).first();
        } else {
            order = await db.orm.public.Order.where({ externalId: externalOrderId, workspaceId }).first();
        }
        if (!order) return res.status(404).json({ message: "Order not found" });

        // Idempotency on externalId
        if (externalId) {
            const existingRefund = await db.orm.public.Refund.where({ workspaceId, externalId }).first();
            if (existingRefund) return res.status(200).json({
                id: existingRefund.id,
                refundId: existingRefund.id,
                orderId: existingRefund.orderId,
                externalOrderId: order.externalId,
                externalId: existingRefund.externalId,
                orderStatus: order.status,
                status: "already_processed",
            });
        }

        const amountMinorUnits = toMinorUnits(amount);
        const newRefunded = (order.refundedMinorUnits || 0n) + amountMinorUnits;
        const isFullRefund = newRefunded >= order.netMinorUnits;
        const newStatus = isFullRefund ? "refunded" : "partially_refunded";

        const result = await db.transaction(async (tx) => {
            const refund = await tx.orm.public.Refund.create({
                workspaceId,
                orderId: order.id,
                amountMinorUnits,
                currency: currency.toUpperCase(),
                reason: reason ?? null,
                externalId: externalId ?? null,
                idempotencyKey: idempotencyKey ?? externalId ?? null,
                refundedAt: refundedAt ? new Date(refundedAt).toISOString() : new Date().toISOString(),
            });

            // Update order
            await tx.orm.public.Order.where({ id: order.id }).update({
                refundedMinorUnits: newRefunded,
                status: newStatus,
            });

            await writeAudit(tx.orm.public, {
                workspaceId,
                actorType: "api_key",
                actorUserId: null,
                action: "refund.created",
                targetType: "refund",
                targetId: refund.id,
                metadata: { orderId: order.id, externalOrderId: order.externalId, amountMinorUnits: amountMinorUnits.toString() },
                ip: req.ip ?? null,
                userAgent: req.headers["user-agent"] ?? null,
            });

            return refund;
        });

        // Dispatch outbound webhook (fire-and-forget)
        dispatchWebhook(workspaceId, "refund.created", {
            refundId: result.id,
            orderId: order.id,
            externalOrderId: order.externalId,
            amountMinorUnits: result.amountMinorUnits?.toString(),
            currency: result.currency,
            orderStatus: newStatus,
            refundedAt: result.refundedAt,
        });

        return res.status(201).json({
            id: result.id,
            refundId: result.id,
            orderId: order.id,
            externalOrderId: order.externalId,
            externalId: result.externalId,
            amountMinorUnits: result.amountMinorUnits?.toString(),
            currency: result.currency,
            orderStatus: newStatus,
            refundedAt: result.refundedAt,
        });
    } catch (error) {
        console.error("createRefund error:", error.message);
        return res.status(500).json({ message: "Internal server error while creating refund" });
    }
};
