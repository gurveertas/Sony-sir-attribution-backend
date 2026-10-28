/**
 * Bookings — POST /v1/bookings | PATCH /v1/bookings/:id | GET /v1/bookings | GET /v1/bookings/upcoming
 *
 * Bookings are attributed when they are CREATED (anchored at `bookedAt`), not when paid; the invoice
 * that pays one (POST /v1/orders with bookingId / bookingExternalId, or the same checkout token)
 * inherits the booking's credit. Booked value (service price at booking) is kept separate from
 * realized revenue (paid orders).
 *
 * POST body:
 *   externalId*  appointmentStartAt*  currency*  bookedValue (major units) | bookedValueMinorUnits
 *   bookedAt?    when the customer made the booking (default: when we received it)
 *   status?      scheduled | confirmed | completed | cancelled | rescheduled | no_show
 *   serviceName? appointmentEndAt? locationId? | locationExternalId?
 *   checkoutToken? email? phone? customerExternalId? visitorId? gclid? fbclid? ttclid? msclkid?
 * PATCH body: status? reason? appointmentStartAt? (reschedule) bookedValue? serviceName? locationId?
 */

import { db } from "../src/prisma/db.js";
import { tenantDb } from "../services/tenantDb.js";
import { ingestBooking, updateBookingRecord, BOOKING_STATUSES } from "../services/ingestion.js";
import { resolveListWindow } from "./reportsController.js";
import { sendError, wantsCsv, sendCsv, paginate, sortDesc } from "../services/http.js";
import { primarySource } from "./orderController.js";
import { ATTRIBUTION_MODELS, DEFAULT_MODEL } from "../services/attributionEngine.js";
import { localDateString } from "../utils/timezone.js";
import { allowedLocationFilter, makeConverter, fxSummary } from "../services/metrics.js";

const ingestCtx = (req) => ({
    connectorId: req.connector?.id ?? null,
    connectorType: req.connector?.type ?? null,
    receivedAt: req.receivedAt ?? null,
    isTest: req.apiKey?.mode === "test" || Boolean(req.isTest),
    applyChanges: Boolean(req.connector),
});

export const createBooking = async (req, res) => {
    try {
        const result = await ingestBooking(req.workspaceId, req.body ?? {}, ingestCtx(req));
        return res.status(result.statusCode).json(result.body);
    } catch (error) {
        return sendError(res, error, "createBooking");
    }
};

export const updateBooking = async (req, res) => {
    try {
        const result = await updateBookingRecord(req.workspaceId, req.params.id, req.body ?? {}, ingestCtx(req));
        return res.status(result.statusCode).json(result.body);
    } catch (error) {
        return sendError(res, error, "updateBooking");
    }
};

const resolveWorkspace = (req) => req.workspaceId || req.user?.workspaceId || req.params?.workspaceId;

async function decorate(t, bookings, model) {
    const credits = bookings.length ? await t.AttributionCredit.where({ model }).all() : [];
    const byBooking = new Map();
    for (const c of credits) {
        if (!c.bookingId) continue;
        if (!byBooking.has(c.bookingId)) byBooking.set(c.bookingId, []);
        byBooking.get(c.bookingId).push(c);
    }
    const locations = new Map((await t.Location.all()).map((l) => [l.id, l]));
    return { byBooking, locations };
}

const serialize = (b, src, locations, tz) => {
    const loc = b.locationId ? locations.get(b.locationId) : null;
    const zone = loc?.timezone || tz;
    return {
        id: b.id,
        externalId: b.externalId,
        status: b.status,
        serviceName: b.serviceName,
        currency: b.currency,
        bookedValueMinorUnits: b.bookedValueMinorUnits?.toString(),
        appointmentStartAt: b.appointmentStartAt,
        appointmentLocalDate: zone ? localDateString(new Date(b.appointmentStartAt), zone) : null,
        bookedAt: b.bookedAt ?? b.createdAt,
        leadTimeHours: Math.round((new Date(b.appointmentStartAt) - new Date(b.bookedAt ?? b.createdAt)) / 36e5),
        locationId: b.locationId,
        locationName: loc?.name ?? null,
        customerId: b.customerId,
        isNewCustomer: b.isNewCustomer,
        guestType: b.customerId ? (b.isNewCustomer ? "new" : "returning") : "unknown",
        source: src.channel,
        campaign: src.campaign,
        matchMethod: b.matchMethod,
        attributionReason: b.attributionReason ?? null,
        createdAt: b.createdAt,
    };
};

/**
 * GET /v1/bookings — filters: from/to on the booking's appointment date (or dateField=bookedAt),
 * status, locationId, channel, model, newVsReturning, includeTest; cursor/page; format=csv.
 */
export const listBookings = async (req, res) => {
    try {
        const workspaceId = resolveWorkspace(req);
        const t = tenantDb(db, workspaceId);
        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
        const model = ATTRIBUTION_MODELS.includes(req.query.model) ? req.query.model : workspace?.defaultModel || DEFAULT_MODEL;
        const field = req.query.dateField === "bookedAt" ? "bookedAt" : "appointmentStartAt";

        let rows = await t.Booking.all();
        const { fromIso, toIso } = await resolveListWindow(req, workspaceId);
        const at = (b) => new Date(field === "bookedAt" ? b.bookedAt ?? b.createdAt : b.appointmentStartAt);
        if (fromIso) rows = rows.filter((b) => at(b) >= new Date(fromIso));
        if (toIso) rows = rows.filter((b) => at(b) <= new Date(toIso));
        const q = req.query;
        const allowedLocs = allowedLocationFilter(req);
        if (allowedLocs) rows = rows.filter((b) => allowedLocs.has(b.locationId));
        if (q.includeTest !== "true") rows = rows.filter((b) => !b.isTest);
        if (q.status) {
            if (!BOOKING_STATUSES.includes(q.status)) return res.status(400).json({ message: "Invalid status", code: "validation_error" });
            rows = rows.filter((b) => b.status === q.status);
        }
        if (q.locationId) rows = rows.filter((b) => b.locationId === q.locationId);
        if (q.newVsReturning === "new") rows = rows.filter((b) => b.customerId && b.isNewCustomer);
        if (q.newVsReturning === "returning") rows = rows.filter((b) => b.customerId && !b.isNewCustomer);

        const { byBooking, locations } = await decorate(t, rows, model);
        if (q.channel) rows = rows.filter((b) => (byBooking.get(b.id) ?? []).some((c) => (c.channel ?? "direct_unknown") === q.channel));

        const sortKey = field === "bookedAt" ? "createdAt" : "appointmentStartAt";
        sortDesc(rows, sortKey);
        const exporting = wantsCsv(req);
        const { data: pageRows, pagination } = exporting ? { data: rows, pagination: null } : paginate(rows, req, sortKey);
        const data = pageRows.map((b) => serialize(b, primarySource(byBooking.get(b.id)), locations, workspace?.timezone));

        if (exporting) {
            return sendCsv(res, "bookings.csv", data, [
                "appointmentStartAt", "bookedAt", "externalId", "status", "serviceName", "locationName", "currency",
                "bookedValueMinorUnits", "guestType", "source", "campaign", "matchMethod", "leadTimeHours",
            ]);
        }
        return res.status(200).json({ model, data, pagination, lastUpdated: new Date().toISOString() });
    } catch (error) {
        return sendError(res, error, "listBookings");
    }
};

/**
 * GET /v1/bookings/upcoming — scheduled/confirmed bookings from now on, with totals by local day,
 * by local week (company week start), by location, by service and by source.
 * Query: days (1-90, default 14), locationId, model, format=csv.
 */
export const listUpcomingBookings = async (req, res) => {
    try {
        const workspaceId = resolveWorkspace(req);
        const t = tenantDb(db, workspaceId);
        const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
        const tz = req.query.tz || workspace?.timezone || "UTC";
        const model = ATTRIBUTION_MODELS.includes(req.query.model) ? req.query.model : workspace?.defaultModel || DEFAULT_MODEL;
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
        const now = new Date();
        const until = new Date(now.getTime() + days * 86_400_000);

        let rows = (await t.Booking.all()).filter(
            (b) => !b.isTest && ["scheduled", "confirmed", "rescheduled"].includes(b.status) && new Date(b.appointmentStartAt) >= now && new Date(b.appointmentStartAt) <= until,
        );
        if (req.query.locationId) rows = rows.filter((b) => b.locationId === req.query.locationId);
        const allowedLocs = allowedLocationFilter(req);
        if (allowedLocs) rows = rows.filter((b) => allowedLocs.has(b.locationId));
        rows.sort((a, b) => new Date(a.appointmentStartAt) - new Date(b.appointmentStartAt));

        const { byBooking, locations } = await decorate(t, rows, model);
        // booked values in the reporting currency, with the company's FX mode (dynamic: follows rate changes)
        const reporting = workspace?.reportingCurrency || "USD";
        const fxMode = ["transaction_date", "latest"].includes(req.query.fxMode) ? req.query.fxMode : workspace?.fxRateMode || "transaction_date";
        const convert = makeConverter(db, reporting, fxMode);
        let missingFx = 0;
        const data = [];
        for (const b of rows) {
            const row = serialize(b, primarySource(byBooking.get(b.id)), locations, tz);
            const converted = await convert(b.bookedValueMinorUnits, b.currency || reporting, String(b.bookedAt ?? b.createdAt).slice(0, 10), null, null);
            if (converted === null) missingFx++;
            row.reportingValueMinorUnits = converted === null ? null : converted.toString();
            row.reportingCurrency = reporting;
            data.push(row);
        }

        const weekStart = Number.isInteger(workspace?.weekStart) ? workspace.weekStart : 1;
        const weekOf = (day) => {
            const d = new Date(`${day}T00:00:00Z`);
            const diff = (d.getUTCDay() - weekStart + 7) % 7;
            d.setUTCDate(d.getUTCDate() - diff);
            return d.toISOString().slice(0, 10);
        };
        const bump = (map, key, b) => {
            const e = map.get(key) ?? { key, count: 0, bookedValueMinorUnits: 0n, newGuests: 0 };
            e.count++;
            e.bookedValueMinorUnits += BigInt(b.reportingValueMinorUnits ?? 0); // reporting currency
            if (b.guestType === "new") e.newGuests++;
            map.set(key, e);
        };
        const groups = { byDay: new Map(), byWeek: new Map(), byLocation: new Map(), byService: new Map(), bySource: new Map() };
        for (const b of data) {
            bump(groups.byDay, b.appointmentLocalDate, b);
            bump(groups.byWeek, weekOf(b.appointmentLocalDate), b);
            bump(groups.byLocation, b.locationName ?? "(No location)", b);
            bump(groups.byService, b.serviceName ?? "(Unknown service)", b);
            bump(groups.bySource, b.source, b);
        }
        const out = (m) => [...m.values()].map((e) => ({ ...e, bookedValueMinorUnits: e.bookedValueMinorUnits.toString() }));

        if (wantsCsv(req)) {
            return sendCsv(res, "upcoming-bookings.csv", data, ["appointmentStartAt", "appointmentLocalDate", "serviceName", "locationName", "status", "currency", "bookedValueMinorUnits", "reportingCurrency", "reportingValueMinorUnits", "guestType", "source"]);
        }
        const total = data.reduce((s, b) => s + BigInt(b.reportingValueMinorUnits ?? 0), 0n);
        return res.status(200).json({
            period: { from: now.toISOString(), to: until.toISOString(), tz },
            model,
            days,
            count: data.length,
            bookedValueMinorUnits: total.toString(),
            currency: reporting,
            fx: fxSummary(convert, reporting),
            warnings: missingFx ? [`${missingFx} booking(s) have no exchange rate to ${reporting} and are left out of the booked value.`] : [],
            byDay: out(groups.byDay).sort((a, b) => a.key.localeCompare(b.key)),
            byWeek: out(groups.byWeek).sort((a, b) => a.key.localeCompare(b.key)),
            byLocation: out(groups.byLocation),
            byService: out(groups.byService),
            bySource: out(groups.bySource),
            data,
            lastUpdated: new Date().toISOString(),
        });
    } catch (error) {
        return sendError(res, error, "listUpcomingBookings");
    }
};
