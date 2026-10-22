/**
 * Orders & Conversions Controller  —  POST /v1/orders  |  PATCH /v1/orders/:id
 *
 * Ingests a paid order, resolves its customer, matches it to attribution touches,
 * runs all 6 attribution models and writes AttributionCredit rows — all in one transaction.
 *
 * POST Body:
 *   externalId*       - your system's order ID (idempotency key)
 *   orderedAt*        - ISO timestamp of when the order was paid
 *   currency*         - ISO 4217 (e.g. "USD", "INR")
 *   grossAmount*      - gross amount (in major units, e.g. 99.99)
 *   netAmount*        - net amount after discounts/tax (major units)
 *   discountAmount?   - discount (major units)
 *   taxAmount?        - tax (major units)
 *   checkoutToken?    - token from /v1/checkout-sessions
 *   visitorId?        - client-side visitor ID (fallback if no token)
 *   email?            - customer email (for identity resolution fallback)
 *   phone?            - customer phone (for identity resolution fallback)
 *   locationId?       - your workspace location ID
 *   items?            - array of { name, quantity, unitAmount, currency, externalId? }
 *   idempotencyKey?   - custom idempotency key (defaults to externalId)
 *   connectorId?      - connector that sent this event
 */

import { db } from "../src/prisma/db.js";
import { isPaidOrder } from "../services/customerMerge.js";
import { resolveListWindow } from "./reportsController.js";
import { resolveOrCreateCustomer, getVisitorTouches, linkVisitorToCustomer, hashIdentifier } from "../services/identityService.js";
import { filterTouches, buildCreditRows } from "../services/attributionEngine.js";
import { dispatchWebhook } from "../services/webhookDispatcher.js";
import { writeAudit } from "../services/audit.js";

const toMinorUnits = (amount, decimals = 2) => BigInt(Math.round(Number(amount) * Math.pow(10, decimals)));

export const createOrder = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;

        const {
            externalId,
            orderedAt,
            currency,
            grossAmount,
            netAmount,
            discountAmount = 0,
            taxAmount = 0,
            checkoutToken,
            visitorId,
            email,
            phone,
            locationId,
            items = [],
            idempotencyKey,
            connectorId,
        } = req.body ?? {};

        // Required field validation
        if (!externalId) return res.status(400).json({ message: "externalId is required" });
        if (!orderedAt) return res.status(400).json({ message: "orderedAt is required" });
        if (!currency || typeof currency !== "string" || currency.length !== 3)
            return res.status(400).json({ message: "currency must be a 3-character ISO code" });
        if (grossAmount === undefined) return res.status(400).json({ message: "grossAmount is required" });
        if (netAmount === undefined) return res.status(400).json({ message: "netAmount is required" });

        // Idempotency: check if we've already processed this order
        const ikey = idempotencyKey || externalId;
        const existing = await db.orm.public.Order.where({ workspaceId, externalId }).first();
        if (existing) {
            const [items, credits, session] = await Promise.all([
                db.orm.public.OrderItem.where({ orderId: existing.id }).all(),
                db.orm.public.AttributionCredit.where({ orderId: existing.id }).all(),
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
                orderId: existing.id,
                externalId: existing.externalId,
                customerId: existing.customerId,
                visitorId: visitor?.visitorId ?? visitorId ?? null,
                visitorRecordId: visitor?.id ?? null,
                connectorId: existing.connectorId,
                locationId: existing.locationId,
                checkoutSessionId: session?.id ?? null,
                touchIds: [...new Set(credits.map((credit) => credit.touchId).filter(Boolean))],
                orderItemIds: items.map((item) => item.id),
                attributionCreditIds: credits.map((credit) => credit.id),
                status: "already_processed",
                message: "Duplicate order — already ingested",
            });
        }

        const grossMinorUnits = toMinorUnits(grossAmount);
        const netMinorUnits = toMinorUnits(netAmount);
        const discountMinorUnits = toMinorUnits(discountAmount);
        const taxMinorUnits = toMinorUnits(taxAmount);

        // Get workspace settings for attribution
        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
        if (!workspace) return res.status(404).json({ message: "Workspace not found" });

        // ── Identity Resolution ────────────────────────────────────
        const { customer, isNew: isNewCustomer } = await resolveOrCreateCustomer(db, workspaceId, { email, phone });

        // Link visitor if provided
        if (visitorId) await linkVisitorToCustomer(db, workspaceId, visitorId, customer.id);

        // ── Touch Resolution ───────────────────────────────────────
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
                // Load touch records from the frozen snapshot
                const touchIds = (session.frozenTouches || []).map(t => t.id).filter(Boolean);
                if (touchIds.length > 0) {
                    const allTouches = await db.orm.public.Touch.where({ visitorId: session.visitorId }).all();
                    touches = allTouches.filter(t => touchIds.includes(t.id));
                }
                matchMethod = "token";
            }
        }

        // Fallback: resolve by email/phone → find linked visitor
        if (touches.length === 0 && (email || phone)) {
            if (customer) {
                const visitors = await db.orm.public.Visitor.where({ workspaceId, customerId: customer.id }).all();
                for (const v of visitors) {
                    const vTouches = await db.orm.public.Touch.where({ visitorId: v.id }).all();
                    touches.push(...vTouches);
                }
                if (touches.length > 0) matchMethod = email ? "email" : "phone";
            }
        }

        // Fallback: direct visitorId
        if (touches.length === 0 && visitorId) {
            touches = await getVisitorTouches(workspaceId, visitorId);
            if (touches.length > 0) matchMethod = "click_id";
        }

        // Apply lookback window filter
        const lookbackDays = workspace.lookbackDays || 30;
        touches = filterTouches(touches, lookbackDays, orderedAt, workspace.lookbackOverrides || {});

        // ── Check new vs returning ─────────────────────────────────
        const priorOrders = customer
            ? await db.orm.public.Order.where({ workspaceId, customerId: customer.id }).all()
            : [];
        const customerIsNew = priorOrders.filter(o => isPaidOrder(o) && new Date(o.orderedAt) < new Date(orderedAt)).length === 0;

        // ── Build credit rows for all 6 models ─────────────────────
        const creditRows = buildCreditRows({
            workspaceId,
            orderId: null, // filled after order creation
            touches,
            orderedAt,
            netMinorUnits,
            currency,
        });

        // ── Transaction: save order + items + attribution ───────────
        const result = await db.transaction(async (tx) => {
            const order = await tx.orm.public.Order.create({
                workspaceId,
                locationId: locationId ?? null,
                customerId: customer?.id ?? null,
                externalId,
                connectorId: connectorId ?? null,
                status: "paid",
                grossMinorUnits,
                netMinorUnits,
                discountMinorUnits,
                taxMinorUnits,
                currency: currency.toUpperCase(),
                checkoutToken: checkoutToken ?? null,
                matchMethod,
                isNewCustomer: customerIsNew,
                idempotencyKey: ikey,
                orderedAt: new Date(orderedAt).toISOString(),
            });

            // Save order items
            const orderItemIds = [];
            for (const item of items) {
                const createdItem = await tx.orm.public.OrderItem.create({
                    orderId: order.id,
                    name: item.name || "Item",
                    quantity: item.quantity || 1,
                    unitMinorUnits: toMinorUnits(item.unitAmount || 0),
                    totalMinorUnits: toMinorUnits((item.unitAmount || 0) * (item.quantity || 1)),
                    currency: (item.currency || currency).toUpperCase(),
                    externalId: item.externalId ?? null,
                });
                orderItemIds.push(createdItem.id);
            }

            // Mark checkout session as consumed
            if (checkoutToken) {
                const session = await tx.orm.public.CheckoutSession.where({ token: checkoutToken, workspaceId }).first();
                if (session) {
                    checkoutSessionId = session.id;
                    await tx.orm.public.CheckoutSession.where({ id: session.id }).update({
                        consumedAt: new Date().toISOString(),
                        consumedOrderId: order.id,
                    });
                }
            }

            // Save attribution credits (all 6 models)
            const attributionCredits = [];
            for (const row of creditRows) {
                attributionCredits.push(
                    await tx.orm.public.AttributionCredit.create({ ...row, orderId: order.id })
                );
            }

            // Update customer purchase timestamps
            if (customer) {
                const updates = { lastPurchaseAt: new Date(orderedAt).toISOString() };
                if (customerIsNew) updates.firstPurchaseAt = new Date(orderedAt).toISOString();
                await tx.orm.public.Customer.where({ id: customer.id }).update(updates);
            }

            // Audit log
            await writeAudit(tx.orm.public, {
                workspaceId,
                actorType: "api_key",
                actorUserId: null,
                action: "order.created",
                targetType: "order",
                targetId: order.id,
                metadata: { externalId, matchMethod, isNewCustomer: customerIsNew, touchCount: touches.length },
                ip: req.ip ?? null,
                userAgent: req.headers["user-agent"] ?? null,
            });

            return { order, orderItemIds, attributionCredits };
        });

        const order = result.order;

        // Dispatch outbound webhook (fire-and-forget)
        dispatchWebhook(workspaceId, "order.created", {
            orderId: order.id,
            externalId: order.externalId,
            status: order.status,
            grossMinorUnits: order.grossMinorUnits?.toString(),
            netMinorUnits: order.netMinorUnits?.toString(),
            currency: order.currency,
            matchMethod,
            isNewCustomer: customerIsNew,
            touchCount: touches.length,
            orderedAt: order.orderedAt,
        });

        return res.status(201).json({
            id: order.id,
            orderId: order.id,
            externalId: order.externalId,
            customerId: order.customerId,
            visitorId: resolvedVisitor?.visitorId ?? visitorId ?? null,
            visitorRecordId: resolvedVisitor?.id ?? null,
            connectorId: order.connectorId,
            locationId: order.locationId,
            checkoutSessionId,
            touchIds: [...new Set(touches.map((touch) => touch.id))],
            orderItemIds: result.orderItemIds,
            attributionCreditIds: result.attributionCredits.map((credit) => credit.id),
            status: order.status,
            matchMethod,
            isNewCustomer: customerIsNew,
            touchCount: touches.length,
            currency: order.currency,
        });
    } catch (error) {
        console.error("createOrder error:", error.message);
        return res.status(500).json({ message: "Internal server error while ingesting order" });
    }
};

/**
 * PATCH /v1/orders/:id — update order status
 */
export const updateOrder = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;
        const order = await db.orm.public.Order.where({ id: req.params.id, workspaceId }).first();
        if (!order) return res.status(404).json({ message: "Order not found" });

        const allowed = ["status"];
        const changes = Object.fromEntries(
            Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k))
        );

        if (!Object.keys(changes).length) return res.status(400).json({ message: "Nothing to update" });

        await db.orm.public.Order.where({ id: order.id }).update(changes);

        // Dispatch outbound webhook
        dispatchWebhook(workspaceId, "order.updated", {
            orderId: order.id,
            externalId: order.externalId,
            ...changes,
        });

        return res.status(200).json({
            id: order.id,
            orderId: order.id,
            status: changes.status,
            message: "Order updated",
        });
    } catch (error) {
        console.error("updateOrder error:", error.message);
        return res.status(500).json({ message: "Internal server error while updating order" });
    }
};

/**
 * GET /v1/orders — list orders for this workspace
 */
export const listOrders = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        const offset = (page - 1) * limit;

        let query = db.orm.public.Order.where((o) => o.workspaceId.eq(workspaceId));

        if (req.query.status) {
            query = query.where((o) => o.status.eq(req.query.status));
        }
        if (req.query.locationId) {
            query = query.where((o) => o.locationId.eq(req.query.locationId));
        }
        const { fromIso, toIso } = await resolveListWindow(req, workspaceId);
        if (fromIso) query = query.where((o) => o.orderedAt.gte(fromIso));
        if (toIso) query = query.where((o) => o.orderedAt.lte(toIso));

        const countResult = await query.aggregate((agg) => ({ total: agg.count() }));
        const total = countResult?.total || 0;

        const orders = await query
            .orderBy((o) => o.orderedAt.desc())
            .limit(limit)
            .offset(offset)
            .all();

        const data = orders.map((o) => ({
            id: o.id,
            externalId: o.externalId,
            status: o.status,
            currency: o.currency,
            netMinorUnits: o.netMinorUnits?.toString(),
            grossMinorUnits: o.grossMinorUnits?.toString(),
            matchMethod: o.matchMethod,
            isNewCustomer: o.isNewCustomer,
            locationId: o.locationId,
            customerId: o.customerId,
            orderedAt: o.orderedAt,
            createdAt: o.createdAt,
        }));

        return res.status(200).json({
            data,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    } catch (error) {
        if (error?.statusCode === 400) return res.status(400).json({ message: error.message });
        console.error("listOrders error:", error.message);
        return res.status(500).json({ message: "Internal server error while listing orders" });
    }
};

/**
 * GET /v1/orders/:id/attribution — get attribution credits for an order
 */
export const getOrderAttribution = async (req, res) => {
    try {
        const workspaceId = req.workspaceId;
        const order = await db.orm.public.Order.where({ id: req.params.id, workspaceId }).first();
        if (!order) return res.status(404).json({ message: "Order not found" });

        const credits = await db.orm.public.AttributionCredit.where({ orderId: order.id }).all();

        // Group by model
        const byModel = {};
        for (const credit of credits) {
            if (!byModel[credit.model]) byModel[credit.model] = [];
            byModel[credit.model].push({
                id: credit.id,
                attributionCreditId: credit.id,
                touchId: credit.touchId,
                share: credit.share,
                amountMinorUnits: credit.amountMinorUnits?.toString(),
                currency: credit.currency,
            });
        }

        return res.status(200).json({
            orderId: order.id,
            externalId: order.externalId,
            matchMethod: order.matchMethod,
            attribution: byModel,
        });
    } catch (error) {
        console.error("getOrderAttribution error:", error.message);
        return res.status(500).json({ message: "Internal server error while fetching attribution" });
    }
};
