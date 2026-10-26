/**
 * Privacy (scope 4.10): data export and deletion by customer, retention, company data deletion.
 * GDPR / UK GDPR / DPDP (India) / CCPA access and erasure requests are served from here.
 *
 *   exportCustomer   everything stored about one customer (JSON)
 *   eraseCustomer    removes personal data; revenue history stays (anonymous), credits keep their
 *                    channel so reports do not change, touches and visitors of the person are deleted
 *   applyRetention   deletes raw payloads older than the company's retention (default 13 months)
 *   purgeWorkspace   deletes ALL of a company's data (platform admin tool, on request)
 */

import { db } from "../src/prisma/db.js";
import { tenantDb } from "./tenantDb.js";
import { decryptSecret } from "../utils/crypto.js";
import { writeAudit, deleteAuditEntries } from "./audit.js";

const safe = (row) => {
    if (!row) return row;
    const { emailEnc, emailHash, phoneHash, credentialsEnc, secretsEnc, signingSecretEnc, ...rest } = row;
    return rest;
};
const json = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : Buffer.isBuffer(x) ? undefined : x)));

export async function exportCustomer(workspaceId, customerId, client = db) {
    const t = tenantDb(client, workspaceId);
    const customer = await t.Customer.where({ id: customerId }).first();
    if (!customer) return null;
    const visitors = await t.Visitor.where({ customerId }).all();
    const touches = [];
    for (const v of visitors) touches.push(...(await t.Touch.where({ visitorId: v.id }).all()));
    const orders = await t.Order.where({ customerId }).all();
    const refunds = [];
    const items = [];
    for (const o of orders) {
        refunds.push(...(await t.Refund.where({ orderId: o.id }).all()));
        items.push(...(await client.orm.public.OrderItem.where({ orderId: o.id }).all()));
    }
    const bookings = await t.Booking.where({ customerId }).all();
    return json({
        exportedAt: new Date().toISOString(),
        customer: { ...safe(customer), email: customer.emailEnc ? decryptSecret(customer.emailEnc) : null, hasPhone: Boolean(customer.phoneHash) },
        visitors: visitors.map(safe),
        touches: touches.map(safe),
        orders: orders.map((o) => ({ ...safe(o), rawPayload: undefined })),
        orderItems: items,
        refunds,
        bookings: bookings.map((b) => ({ ...safe(b), rawPayload: undefined })),
    });
}

/**
 * Erase one customer's personal data. Orders and bookings are kept (they are the company's
 * accounting records) but no longer point to anything that identifies the person.
 */
export async function eraseCustomer(workspaceId, customerId, { actorUserId = null, reason = null, ip = null, userAgent = null } = {}, client = db) {
    const t = tenantDb(client, workspaceId);
    const customer = await t.Customer.where({ id: customerId }).first();
    if (!customer) return null;
    const email = customer.emailEnc ? decryptSecret(customer.emailEnc) : null;
    const visitors = await t.Visitor.where({ customerId }).all();
    // customers merged into this one are the same person
    const merged = await t.Customer.where({ mergedIntoId: customerId }).all();

    let touchesDeleted = 0;
    await client.transaction(async (tx) => {
        const tt = tenantDb(tx, workspaceId);
        for (const v of visitors) {
            const touches = await tt.Touch.where({ visitorId: v.id }).all();
            for (const touch of touches) {
                // keep the credit (channel + campaign are stored on it), drop the link to the visit
                await tt.AttributionCredit.where({ touchId: touch.id }).update({ touchId: null });
            }
            for (const s of await tt.CheckoutSession.where({ visitorId: v.id }).all()) await tt.CheckoutSession.where({ id: s.id }).update({ frozenTouches: [] });
            await tt.Touch.where({ visitorId: v.id }).delete();
            touchesDeleted += touches.length;
        }
        for (const c of [customer, ...merged]) {
            await tt.Customer.where({ id: c.id }).update({ emailHash: null, emailEnc: null, phoneHash: null, externalIds: null, erasedAt: new Date().toISOString() });
        }
        for (const v of visitors) await tt.Visitor.where({ id: v.id }).update({ customerId: null, visitorId: `erased:${v.id}` });
    });

    // raw payloads that mention the person's email are redacted (they would otherwise be replayable)
    let redacted = 0;
    if (email) {
        const raws = await t.RawEvent.all();
        for (const r of raws) {
            if (JSON.stringify(r.payload ?? {}).toLowerCase().includes(email)) {
                await t.RawEvent.where({ id: r.id }).update({ payload: { redacted: true, reason: "customer_erasure" } });
                redacted++;
            }
        }
    }
    await writeAudit(client.orm.public, {
        workspaceId,
        actorType: actorUserId ? "user" : "system",
        actorUserId,
        action: "customer.erased",
        targetType: "customer",
        targetId: customerId,
        reason,
        metadata: { visitors: visitors.length, touchesDeleted, rawEventsRedacted: redacted, mergedRecords: merged.length },
        ip,
        userAgent,
    });
    return { customerId, visitors: visitors.length, touchesDeleted, rawEventsRedacted: redacted };
}

/** Delete raw payloads (and other operational rows) older than each company's retention setting. */
export async function applyRetention(client = db, now = new Date()) {
    const workspaces = await client.orm.public.Workspace.all();
    let rawDeleted = 0;
    for (const w of workspaces) {
        const months = w.rawRetentionMonths || 13;
        const cutoff = new Date(now);
        cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
        const t = tenantDb(client, w.id);
        const old = (await t.RawEvent.where((e) => e.receivedAt.lte(cutoff.toISOString())).all()).filter((e) => e.status === "processed" || e.status === "dead");
        for (const e of old) {
            await t.RawEvent.where({ id: e.id }).delete();
            rawDeleted++;
        }
        const ninety = new Date(now.getTime() - 90 * 86_400_000).toISOString();
        try {
            await t.IdempotencyKey.where((k) => k.createdAt.lte(new Date(now.getTime() - 30 * 86_400_000).toISOString())).delete();
            await t.WebhookDelivery.where((d) => d.createdAt.lte(ninety)).delete();
        } catch {
            /* tables not migrated yet */
        }
    }
    return { rawDeleted };
}

// children first, so foreign keys never block the delete
const PURGE_ORDER = [
    "AttributionCredit", "DailyAttributionRollup", "DailyRollup", "RollupDirtyDay", "WebhookDelivery", "IdempotencyKey",
    "Refund", "Order", "Booking", "CheckoutSession", "Touch", "Visitor", "Customer", "RawEvent",
    "AdSpend", "AdAccount", "Connector", "WebhookEndpoint", "ChannelMappingRule", "UserLocationAccess",
    "ApiKey", "Site", "Location", "Invite", "SupportAccessSession",
]; // AuditLog is removed through services/audit.js

/**
 * Delete a company's data on request (platform admin). `keepAccount` keeps the workspace, users and
 * settings (a "reset"); otherwise the workspace itself is deleted too. The audit entry is written
 * without a workspace id so it survives the deletion.
 */
export async function purgeWorkspace(workspaceId, { keepAccount = false, actorUserId, reason, ip = null, userAgent = null } = {}, client = db) {
    const workspace = await client.orm.public.Workspace.where({ id: workspaceId }).first();
    if (!workspace) return null;
    const t = tenantDb(client, workspaceId);
    const counts = {};
    // order items and booking history hang off orders / bookings
    for (const o of await t.Order.all()) await client.orm.public.OrderItem.where({ orderId: o.id }).delete();
    for (const b of await t.Booking.all()) await client.orm.public.BookingStatusHistory.where({ bookingId: b.id }).delete();
    for (const model of PURGE_ORDER) {
        if (keepAccount && ["ApiKey", "Site", "Location", "UserLocationAccess", "Invite", "ChannelMappingRule", "WebhookEndpoint"].includes(model)) continue;
        try {
            const rows = await t[model].all();
            counts[model] = rows.length;
            if (rows.length) await t[model].where({ workspaceId }).delete();
        } catch {
            counts[model] = "n/a";
        }
    }
    // stored background jobs of the company (not tenant-scoped: some jobs have no company)
    try {
        await client.orm.public.BackgroundJob?.where({ workspaceId }).delete();
    } catch {
        /* table not migrated */
    }
    if (!keepAccount) {
        await deleteAuditEntries(client.orm.public, workspaceId).catch(() => {});
        await client.orm.public.User.where({ workspaceId }).delete();
        await client.orm.public.Workspace.where({ id: workspaceId }).delete();
    } else {
        await client.orm.public.Workspace.where({ id: workspaceId }).update({ rollupsBuiltAt: null, rollupsBuiltToken: null });
    }
    await writeAudit(client.orm.public, {
        workspaceId: keepAccount ? workspaceId : null,
        actorType: "platform_admin",
        actorUserId,
        action: keepAccount ? "admin.workspace_data_deleted" : "admin.workspace_deleted",
        targetType: "workspace",
        targetId: workspaceId,
        reason,
        metadata: { name: workspace.name, slug: workspace.slug, counts },
        ip,
        userAgent,
    });
    return { workspaceId, keepAccount, counts };
}
