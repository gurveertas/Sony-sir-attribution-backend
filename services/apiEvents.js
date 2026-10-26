/**
 * Raw events received through the public API (RawEvent.source = "api") — so API writes are stored
 * before processing exactly like connector events (D4), can be processed asynchronously
 * (`Prefer: respond-async`) and can be replayed by the platform tools.
 */

import { ingestOrder, ingestBooking, ingestRefund, updateBookingRecord, updateOrderRecord } from "./ingestion.js";

export const API_EVENT_TYPES = ["order.paid", "order.updated", "booking.created", "booking.updated", "refund.created"];

export async function processApiEvent(raw) {
    const ctx = { receivedAt: raw.receivedAt, isTest: Boolean(raw.isTest) };
    const p = raw.payload ?? {};
    switch (raw.eventType) {
        case "order.paid":
            return (await ingestOrder(raw.workspaceId, p, ctx)).body;
        case "order.updated":
            return (await updateOrderRecord(raw.workspaceId, p.id, p.body ?? {}, ctx)).body;
        case "booking.created":
            return (await ingestBooking(raw.workspaceId, p, ctx)).body;
        case "booking.updated":
            return (await updateBookingRecord(raw.workspaceId, p.id, p.body ?? {}, ctx)).body;
        case "refund.created":
            return (await ingestRefund(raw.workspaceId, p, ctx)).body;
        default:
            throw Object.assign(new Error(`Unknown API event type "${raw.eventType}"`), { statusCode: 400 });
    }
}
