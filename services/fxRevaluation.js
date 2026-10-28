/**
 * Dynamic FX (scope 4.11): when the FX sync adds or changes rates, re-convert the sales and bookings
 * those rates affect, following each company's `fxRateMode`.
 *
 *   transaction_date  A sale keeps the rate of its own day, stored on the order (fxRateToReporting).
 *                     When the rate of day D changes (or arrives late), orders dated D..D+7 that used it
 *                     (directly or as the weekend/holiday fallback) get their stored rate refreshed.
 *                     Bookings are converted at their booking day's rate when a report runs, so they
 *                     follow automatically. Refunds use their order's rate.
 *   latest            Every sale, refund and booking is converted at the newest rate when a report runs,
 *                     so a change of the newest rate re-values the company's whole history.
 *
 * Either way the company's rollups are rebuilt (reports compute live until they are), so dashboards
 * never show amounts converted with an outdated rate. Manually uploaded rates always win over the feed
 * (services/fx.js keeps them), so a corrected manual rate is never overwritten.
 */

import { db } from "../src/prisma/db.js";
import { tenantDb } from "./tenantDb.js";
import { findRate, latestRateDate, addDaysIso, FX_FALLBACK_DAYS } from "./fx.js";
import { requestRebuild } from "./rollups.js";

const SAME = (a, b) => a !== null && a !== undefined && Math.abs(Number(a) - Number(b)) <= Math.abs(Number(b)) * 1e-9;

/**
 * @param {string[]} changedDates  YYYY-MM-DD days whose rates changed
 * @param {string[]} currencies     currencies the rates cover (used to find affected rows quickly)
 */
export async function applyRateChanges(changedDates, currencies, client = db) {
    const out = { workspacesRebuilt: 0, ordersRepriced: 0, companies: [] };
    if (!changedDates?.length) return out;
    const orm = client.orm.public;
    const sorted = [...changedDates].sort();
    const from = sorted[0];
    const to = addDaysIso(sorted[sorted.length - 1], FX_FALLBACK_DAYS);
    const fromIso = `${from}T00:00:00.000Z`;
    const toIso = `${addDaysIso(to, 1)}T00:00:00.000Z`;
    const newest = await latestRateDate(orm);
    const newestChanged = newest !== null && sorted[sorted.length - 1] >= newest;

    for (const w of await orm.Workspace.where({ status: "active" }).all()) {
        const reporting = (w.reportingCurrency || "USD").toUpperCase();
        const others = currencies.filter((c) => c !== reporting);
        if (!others.length) continue;
        const mode = w.fxRateMode || "transaction_date";
        const t = tenantDb(client, w.id);
        let affected = false;
        let repriced = 0;

        if (mode === "latest") {
            // only a change of the newest rate moves "today's rate"; older corrections do not
            if (!newestChanged) continue;
            const anyOrder = await t.Order.where((o) => o.currency.in(others)).first();
            const anyBooking = anyOrder ? null : await t.Booking.where((b) => b.currency.in(others)).first();
            affected = Boolean(anyOrder || anyBooking);
        } else {
            const orders = await t.Order.where((o) => o.currency.in(others))
                .where((o) => o.orderedAt.gte(fromIso))
                .where((o) => o.orderedAt.lte(toIso))
                .all();
            for (const o of orders) {
                const rate = await findRate(orm, String(o.orderedAt).slice(0, 10), o.currency, reporting);
                if (rate === null) continue;
                if (o.reportingCurrency === reporting && SAME(o.fxRateToReporting, rate)) continue;
                await t.Order.where({ id: o.id }).update({ fxRateToReporting: rate, reportingCurrency: reporting });
                repriced++;
            }
            // bookings are converted at their booking day (bookedAt, older rows: createdAt)
            const inWindow = (field) =>
                t.Booking.where((b) => b.currency.in(others))
                    .where((b) => b[field].gte(fromIso))
                    .where((b) => b[field].lte(toIso))
                    .first();
            const booking = (await inWindow("bookedAt")) ?? (await inWindow("createdAt"));
            affected = repriced > 0 || Boolean(booking);
        }

        if (affected) {
            await requestRebuild(w.id, "fx_rates_changed");
            out.workspacesRebuilt++;
            out.ordersRepriced += repriced;
            out.companies.push({ workspaceId: w.id, mode, ordersRepriced: repriced });
        }
    }
    return out;
}
