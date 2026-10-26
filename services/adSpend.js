/**
 * Ad spend (scope 4.8, store D7): daily spend, impressions and clicks by campaign, from Meta /
 * Google Ads (OAuth sync, services/adPlatforms.js) or a CSV upload for any other channel.
 *
 * Alignment with the company (4.8): spend rows are dated in the AD ACCOUNT's local day. Daily
 * totals cannot be re-split by hour, so an account in a different timezone is matched day-for-day
 * and the reports carry a warning (5.8). Spend in another currency is converted to the reporting
 * currency with the FX snapshot of that day.
 */

import crypto from "crypto";
import { tenantDb } from "./tenantDb.js";
import { db } from "../src/prisma/db.js";
import { toMinorUnits, currencyExponent, isCurrencyCode } from "../utils/money.js";
import { findRate } from "./fx.js";

export const PLATFORM_CHANNEL = { meta: "meta", google: "google" };

const hasSpendStore = (client = db) => {
    try {
        return typeof client.orm.public.AdSpend?.where === "function";
    } catch {
        return false;
    }
};

const dedupeKey = (r) =>
    crypto
        .createHash("sha256")
        .update([r.source, r.adAccountId ?? "", r.platform, r.channel, r.date, r.campaignId ?? r.campaignName, r.adSetName ?? "", r.adName ?? "", r.locationId ?? ""].join("|"))
        .digest("hex");

/** Insert or replace one day/campaign row (re-syncing a day overwrites it). */
export async function upsertSpendRow(t, row) {
    const record = { ...row, dedupeKey: dedupeKey(row) };
    const existing = await t.AdSpend.where({ dedupeKey: record.dedupeKey }).first();
    if (existing) {
        await t.AdSpend.where({ id: existing.id }).update({
            spendMinorUnits: record.spendMinorUnits,
            impressions: record.impressions,
            clicks: record.clicks,
            campaignName: record.campaignName,
            currency: record.currency,
        });
        return { id: existing.id, updated: true };
    }
    const created = await t.AdSpend.create(record);
    return { id: created.id, updated: false };
}

// ── CSV upload ──────────────────────────────────────────────────────────────

function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') {
                cell += '"';
                i++;
            } else if (ch === '"') quoted = false;
            else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ",") {
            row.push(cell);
            cell = "";
        } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            row.push(cell);
            if (row.some((c) => c.trim() !== "")) rows.push(row);
            row = [];
            cell = "";
        } else cell += ch;
    }
    row.push(cell);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    return rows;
}

const HEADER_ALIASES = {
    date: ["date", "day", "reporting_starts", "segments.date"],
    channel: ["channel", "platform", "source", "network"],
    campaign: ["campaign", "campaign_name", "campaign name"],
    campaignId: ["campaign_id", "campaign id"],
    adSet: ["ad_set", "adset", "ad set", "ad group", "ad_group"],
    ad: ["ad", "ad_name", "ad name"],
    spend: ["spend", "cost", "amount", "amount spent"],
    currency: ["currency", "currency_code"],
    impressions: ["impressions", "impr"],
    clicks: ["clicks", "link clicks"],
    location: ["location", "location_id", "center"],
};

/**
 * CSV columns (header names are matched loosely): date (YYYY-MM-DD)*, channel*, campaign*, spend*
 * (major units), currency (default: reporting currency), impressions, clicks, ad_set, ad, campaign_id,
 * location (location id or name). Returns { inserted, updated, errors: [{ line, message }] }.
 */
export async function importSpendCsv(workspaceId, csvText, { defaultCurrency = "USD", client = db } = {}) {
    if (!hasSpendStore(client)) throw Object.assign(new Error("Ad spend storage is not available (run the database migration)"), { statusCode: 503 });
    const t = tenantDb(client, workspaceId);
    const rows = parseCsv(String(csvText ?? ""));
    if (rows.length < 2) throw Object.assign(new Error("The CSV needs a header row and at least one data row"), { statusCode: 400 });
    if (rows.length > 20001) throw Object.assign(new Error("At most 20,000 rows per upload"), { statusCode: 400 });

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = Object.fromEntries(Object.entries(HEADER_ALIASES).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
    for (const required of ["date", "channel", "campaign", "spend"]) {
        if (col[required] === -1) throw Object.assign(new Error(`Missing column: ${required}`), { statusCode: 400 });
    }

    const locations = await t.Location.all();
    const result = { inserted: 0, updated: 0, errors: [] };
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const get = (k) => (col[k] >= 0 ? String(r[col[k]] ?? "").trim() : "");
        try {
            const date = get("date");
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
            const channel = get("channel").toLowerCase();
            if (!channel) throw new Error("channel is required");
            const campaignName = get("campaign") || "(none)";
            const currency = (get("currency") || defaultCurrency).toUpperCase();
            if (!isCurrencyCode(currency)) throw new Error("currency must be a 3-letter code");
            const spend = toMinorUnits(get("spend").replace(/[^0-9.\-]/g, ""), currency, "spend");
            if (spend < 0n) throw new Error("spend cannot be negative");
            const loc = get("location");
            const location = loc ? locations.find((l) => l.id === loc || l.name.toLowerCase() === loc.toLowerCase()) : null;
            if (loc && !location) throw new Error(`unknown location "${loc}"`);
            const platform = channel === "meta" || channel === "facebook" ? "meta" : channel === "google" ? "google" : "other";
            const out = await upsertSpendRow(t, {
                adAccountId: null,
                locationId: location?.id ?? null,
                platform,
                channel: platform === "meta" ? "meta" : channel,
                date,
                campaignId: get("campaignId") || null,
                campaignName,
                adSetName: get("adSet") || null,
                adName: get("ad") || null,
                spendMinorUnits: spend,
                currency,
                impressions: parseInt(get("impressions").replace(/\D/g, ""), 10) || 0,
                clicks: parseInt(get("clicks").replace(/\D/g, ""), 10) || 0,
                source: "csv",
            });
            out.updated ? result.updated++ : result.inserted++;
        } catch (err) {
            if (result.errors.length < 100) result.errors.push({ line: i + 1, message: err.message });
        }
    }
    return result;
}

// ── Reading spend for reports ───────────────────────────────────────────────

/**
 * Spend in [fromDay, toDay] (ad-account local days) converted to `currency`.
 * @returns {{ total, byChannel: Map, byCampaign: Map, byLocation: Map, byPlatform: Map, byDay: Map,
 *             impressions, clicks, rows, warnings: string[] }}
 */
export async function loadSpend(workspaceId, { fromDay, toDay, currency, tz, locationId = null, client = db }) {
    const empty = { total: 0n, byChannel: new Map(), byCampaign: new Map(), byLocation: new Map(), byPlatform: new Map(), byDay: new Map(), impressions: 0, clicks: 0, rows: [], warnings: [], available: false };
    if (!hasSpendStore(client)) return empty;
    const t = tenantDb(client, workspaceId);
    let rows = (await t.AdSpend.all()).filter((r) => r.date >= fromDay && r.date <= toDay);
    if (locationId) rows = rows.filter((r) => r.locationId === locationId);
    const accounts = typeof client.orm.public.AdAccount?.where === "function" ? await t.AdAccount.all() : [];
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    const out = { ...empty, available: true, byChannel: new Map(), byCampaign: new Map(), byLocation: new Map(), byPlatform: new Map(), byDay: new Map(), rows: [], warnings: [] };
    const warned = new Set();
    const rateCache = new Map();
    for (const r of rows) {
        let amount = BigInt(r.spendMinorUnits ?? 0);
        if (r.currency !== currency) {
            const key = `${r.date}|${r.currency}`;
            if (!rateCache.has(key)) rateCache.set(key, await findRate(client.orm.public, r.date, r.currency, currency));
            const rate = rateCache.get(key);
            if (!(rate > 0)) {
                const w = `No ${r.currency}→${currency} rate for ${r.date}: some spend is not included`;
                if (!warned.has(w)) out.warnings.push(w), warned.add(w);
                continue;
            }
            amount = BigInt(Math.round(Number(amount) * rate * 10 ** (currencyExponent(currency) - currencyExponent(r.currency))));
        }
        const acct = r.adAccountId ? accountById.get(r.adAccountId) : null;
        if (acct?.timezone && tz && acct.timezone !== tz) {
            const w = `Ad account "${acct.name}" reports in ${acct.timezone}, the company uses ${tz}: daily spend is matched by calendar day`;
            if (!warned.has(w)) out.warnings.push(w), warned.add(w);
        }
        if (acct?.currency && acct.currency !== currency) {
            const w = `Ad account "${acct.name}" spends in ${acct.currency}; amounts are converted to ${currency}`;
            if (!warned.has(w)) out.warnings.push(w), warned.add(w);
        }
        const add = (map, key, v) => map.set(key, (map.get(key) ?? 0n) + v);
        out.total += amount;
        add(out.byChannel, r.channel, amount);
        add(out.byCampaign, `${r.channel}::${r.campaignName}`, amount);
        if (r.locationId) add(out.byLocation, r.locationId, amount);
        add(out.byPlatform, r.platform, amount);
        add(out.byDay, r.date, amount);
        out.impressions += r.impressions ?? 0;
        out.clicks += r.clicks ?? 0;
        out.rows.push({ ...r, convertedMinorUnits: amount });
    }
    return out;
}
