/**
 * FX snapshots (scope 4.11): "A daily FX rate snapshot is kept so reports in the reporting currency
 * are reproducible." The rate used for an order is stored on the order at ingestion time
 * (Order.fxRateToReporting) and never changes afterwards unless an admin backfills a missing one.
 *
 * Rates live in the FxRate table (date, base, quote, rate), loaded by an admin upload or a feed.
 * Lookup: exact date, else the most recent earlier rate within 7 days, else the inverse pair.
 */

const MAX_STALENESS_DAYS = 7;

const addDaysIso = (day, n) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};

const hasFxStore = (orm) => {
    try {
        return typeof orm?.FxRate?.where === "function";
    } catch {
        return false;
    }
};

/**
 * @param {object} orm  db.orm.public (or tx.orm.public)
 * @param {string} day  YYYY-MM-DD (UTC calendar day of the order)
 * @returns {Promise<number|null>} units of `quote` per 1 unit of `base`, or null when unknown
 */
export async function findRate(orm, day, base, quote) {
    const b = String(base).toUpperCase();
    const q = String(quote).toUpperCase();
    if (b === q) return 1;
    if (!hasFxStore(orm)) return null;
    for (let i = 0; i <= MAX_STALENESS_DAYS; i++) {
        const d = addDaysIso(day, -i);
        const direct = await orm.FxRate.where({ date: d, base: b, quote: q }).first();
        if (direct && Number(direct.rate) > 0) return Number(direct.rate);
        const inverse = await orm.FxRate.where({ date: d, base: q, quote: b }).first();
        if (inverse && Number(inverse.rate) > 0) return 1 / Number(inverse.rate);
    }
    return null;
}

/** Validates and upserts rates: [{date, base, quote, rate}] */
export async function upsertRates(orm, rates, source = "manual") {
    let written = 0;
    for (const r of rates) {
        const date = String(r.date ?? "");
        const base = String(r.base ?? "").toUpperCase();
        const quote = String(r.quote ?? "").toUpperCase();
        const rate = Number(r.rate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote) || !(rate > 0)) {
            const err = new Error(`Invalid FX row: ${JSON.stringify(r)}`);
            err.statusCode = 400;
            throw err;
        }
        const existing = await orm.FxRate.where({ date, base, quote }).first();
        if (existing) await orm.FxRate.where({ id: existing.id }).update({ rate, source });
        else await orm.FxRate.create({ date, base, quote, rate, source });
        written++;
    }
    return written;
}
