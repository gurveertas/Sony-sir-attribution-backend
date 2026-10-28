/**
 * FX snapshots (scope 4.11): "A daily FX rate snapshot is kept so reports in the reporting currency
 * are reproducible." The rate used for an order is stored on the order at ingestion time
 * (Order.fxRateToReporting) and never changes afterwards unless an admin backfills a missing one.
 *
 * Rates live in the FxRate table (date, base, quote, rate), loaded by an admin upload or a feed.
 * Lookup prefers a direct/inverse pair, then derives a cross rate through the daily EUR reference.
 * Rates may fall back to the most recent earlier date within 7 days.
 */

const MAX_STALENESS_DAYS = 7;
const RATE_HISTORY_DAYS = 45;
const FX_PROVIDER_URL = "https://api.frankfurter.dev/v1";
const AUTOMATED_RATE_SOURCE = "frankfurter";

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
    return (await findRateWithDate(orm, day, base, quote))?.rate ?? null;
}

/**
 * Same lookup as findRate, plus the date of the rate that was used (it can be up to 7 days earlier
 * than `day`: weekends and holidays have no ECB rate).
 * @returns {Promise<{rate: number, date: string}|null>}
 */
export async function findRateWithDate(orm, day, base, quote) {
    const b = String(base).toUpperCase();
    const q = String(quote).toUpperCase();
    if (b === q) return { rate: 1, date: day };
    if (!hasFxStore(orm)) return null;
    for (let i = 0; i <= MAX_STALENESS_DAYS; i++) {
        const d = addDaysIso(day, -i);
        const direct = await orm.FxRate.where({ date: d, base: b, quote: q }).first();
        if (direct && Number(direct.rate) > 0) return { rate: Number(direct.rate), date: d };
        const inverse = await orm.FxRate.where({ date: d, base: q, quote: b }).first();
        if (inverse && Number(inverse.rate) > 0) return { rate: 1 / Number(inverse.rate), date: d };
    }

    for (let i = 0; i <= MAX_STALENESS_DAYS; i++) {
        const d = addDaysIso(day, -i);

        const eurToBase = b === "EUR"
            ? 1
            : Number((await orm.FxRate.where({ date: d, base: "EUR", quote: b }).first())?.rate ?? 0);
        const baseToEur = b === "EUR"
            ? 1
            : Number((await orm.FxRate.where({ date: d, base: b, quote: "EUR" }).first())?.rate ?? 0);
        const eurToQuote = q === "EUR"
            ? 1
            : Number((await orm.FxRate.where({ date: d, base: "EUR", quote: q }).first())?.rate ?? 0);
        const quoteToEur = q === "EUR"
            ? 1
            : Number((await orm.FxRate.where({ date: d, base: q, quote: "EUR" }).first())?.rate ?? 0);
        const basePerEur = eurToBase > 0 ? eurToBase : baseToEur > 0 ? 1 / baseToEur : 0;
        const quotePerEur = eurToQuote > 0 ? eurToQuote : quoteToEur > 0 ? 1 / quoteToEur : 0;
        if (basePerEur > 0 && quotePerEur > 0) return { rate: quotePerEur / basePerEur, date: d };
    }
    return null;
}

/** Date of the newest stored rate on or before `day` (what "latest rate" means today), or null. */
export async function latestRateDate(orm, day = new Date().toISOString().slice(0, 10)) {
    if (!hasFxStore(orm)) return null;
    try {
        const rows = await orm.FxRate.where((r) => r.date.lte(day)).orderBy((r) => r.date.desc()).limit(1).all();
        return rows[0]?.date ?? null;
    } catch {
        return null;
    }
}

/** Today's UTC day: the day "latest rate" lookups start from (findRate falls back up to 7 days). */
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

/** How far a change of the rate for day D reaches: sales on D..D+7 may have used it as a fallback. */
export const FX_FALLBACK_DAYS = MAX_STALENESS_DAYS;
export { addDaysIso };

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

async function fetchJson(fetchImpl, url) {
    const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`FX provider returned HTTP ${response.status}`);
    return response.json();
}

/**
 * Fetch a rolling 45-day ECB reference history through Frankfurter. Storing EUR reference pairs
 * lets findRate derive any supported cross-currency rate. Only automated rows are refreshed;
 * manually uploaded rates remain authoritative.
 */
export async function syncLatestRates(orm, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== "function") throw new Error("FX provider fetch is unavailable");

    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    today.setUTCDate(today.getUTCDate() - RATE_HISTORY_DAYS);
    const start = today.toISOString().slice(0, 10);
    const result = await fetchJson(fetchImpl, `${FX_PROVIDER_URL}/${start}..${end}?base=EUR`);
    if (
        result?.base !== "EUR" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(result?.start_date ?? "") ||
        !/^\d{4}-\d{2}-\d{2}$/.test(result?.end_date ?? "") ||
        !result.rates ||
        typeof result.rates !== "object" ||
        Array.isArray(result.rates)
    ) {
        throw new Error("FX provider returned invalid EUR reference rates");
    }

    const rates = Object.entries(result.rates).flatMap(([date, dailyRates]) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !dailyRates || typeof dailyRates !== "object" || Array.isArray(dailyRates)) {
            throw new Error("FX provider returned an invalid daily rate entry");
        }
        return Object.entries(dailyRates)
            .filter(([quote]) => /^[A-Z]{3}$/.test(quote) && quote !== "EUR")
            .map(([quote, value]) => ({ date, base: "EUR", quote, rate: Number(value) }));
    });
    if (!rates.length || rates.some((rate) => !Number.isFinite(rate.rate) || rate.rate <= 0)) {
        throw new Error("FX provider returned no valid currency rates");
    }

    let written = 0;
    let preserved = 0;
    const changedDates = new Set();
    for (const rate of rates) {
        const existing = await orm.FxRate.where({ date: rate.date, base: rate.base, quote: rate.quote }).first();
        if (existing && existing.source !== AUTOMATED_RATE_SOURCE) {
            preserved++;
            continue;
        }
        if (existing && Number(existing.rate) === rate.rate) continue;
        try {
            written += await upsertRates(orm, [rate], AUTOMATED_RATE_SOURCE);
            changedDates.add(rate.date);
        } catch (error) {
            if (error?.code !== "23505" && error?.code !== "P2002") throw error;
            const concurrent = await orm.FxRate.where({ date: rate.date, base: rate.base, quote: rate.quote }).first();
            if (!concurrent) throw error;
            if (concurrent.source !== AUTOMATED_RATE_SOURCE) {
                preserved++;
                continue;
            }
            await orm.FxRate.where({ id: concurrent.id }).update({ rate: rate.rate, source: AUTOMATED_RATE_SOURCE });
            written++;
            changedDates.add(rate.date);
        }
    }
    return {
        startDate: result.start_date,
        date: result.end_date,
        currencies: [...new Set(["EUR", ...rates.map((rate) => rate.quote)])].sort(),
        written,
        preserved,
        /** days whose rates were added or changed by this sync (sales and bookings on them may move) */
        changedDates: [...changedDates].sort(),
    };
}
