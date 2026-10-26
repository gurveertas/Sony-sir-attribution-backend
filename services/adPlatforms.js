/**
 * Meta and Google Ads connections by OAuth (scope 4.8): pull daily spend, impressions and clicks by
 * campaign. Enabled when the platform app credentials are configured:
 *   Meta:   META_APP_ID, META_APP_SECRET                     (scope: ads_read)
 *   Google: GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN (scope: adwords)
 * API versions can be pinned with META_GRAPH_VERSION (default v21.0) and GOOGLE_ADS_API_VERSION (default v18).
 *
 * Tokens are stored encrypted (AdAccount.credentialsEnc). Each sync re-fetches the last few days,
 * because the platforms keep adjusting recent spend.
 */

import jwt from "jsonwebtoken";
import ENV from "../utils/env.js";
import { encryptSecret, decryptSecret } from "../utils/crypto.js";
import { tenantDb } from "./tenantDb.js";
import { db } from "../src/prisma/db.js";
import { upsertSpendRow } from "./adSpend.js";
import { toMinorUnits } from "../utils/money.js";

const META_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const GOOGLE_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v18";
const STATE_TTL = "10m";

export class AdPlatformError extends Error {
    constructor(message, statusCode = 502) {
        super(message);
        this.statusCode = statusCode;
    }
}

export const platformConfigured = (platform) =>
    platform === "meta" ? Boolean(ENV.META_APP_ID && ENV.META_APP_SECRET) : platform === "google" ? Boolean(ENV.GOOGLE_ADS_CLIENT_ID && ENV.GOOGLE_ADS_CLIENT_SECRET && ENV.GOOGLE_ADS_DEVELOPER_TOKEN) : false;

export const callbackUrl = (platform) => `${ENV.APP_API_URL ?? ""}/api/ad-accounts/oauth/${platform}/callback`;

async function call(url, options = {}) {
    let res;
    try {
        res = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
        throw new AdPlatformError(`Ad platform unreachable: ${err.message}`);
    }
    const text = await res.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = { raw: text.slice(0, 200) };
    }
    if (!res.ok) {
        const msg = body?.error?.message || body?.error_description || body?.error || `HTTP ${res.status}`;
        throw new AdPlatformError(`Ad platform error: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
    }
    return body;
}

/** Signed, short-lived OAuth state: carries the company and user through the redirect. */
export function authorizationUrl(platform, { workspaceId, userId }) {
    if (!platformConfigured(platform)) throw new AdPlatformError(`${platform} is not configured on this server`, 501);
    if (!ENV.APP_API_URL) throw new AdPlatformError("APP_API_URL must be set for OAuth redirects", 501);
    const state = jwt.sign({ workspaceId, userId, platform, purpose: "ad_oauth" }, ENV.JWT_SECRET, { expiresIn: STATE_TTL });
    if (platform === "meta") {
        const q = new URLSearchParams({ client_id: ENV.META_APP_ID, redirect_uri: callbackUrl("meta"), state, scope: "ads_read", response_type: "code" });
        return `https://www.facebook.com/${META_VERSION}/dialog/oauth?${q}`;
    }
    const q = new URLSearchParams({
        client_id: ENV.GOOGLE_ADS_CLIENT_ID,
        redirect_uri: callbackUrl("google"),
        response_type: "code",
        scope: "https://www.googleapis.com/auth/adwords",
        access_type: "offline",
        prompt: "consent",
        state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export function verifyState(state, platform) {
    try {
        const s = jwt.verify(String(state ?? ""), ENV.JWT_SECRET);
        if (s.purpose !== "ad_oauth" || s.platform !== platform) throw new Error("wrong state");
        return s;
    } catch {
        throw new AdPlatformError("The connection link expired or is invalid. Start again from Settings.", 400);
    }
}

// ── Meta ────────────────────────────────────────────────────────────────────

async function metaExchange(code) {
    const short = await call(
        `https://graph.facebook.com/${META_VERSION}/oauth/access_token?${new URLSearchParams({ client_id: ENV.META_APP_ID, client_secret: ENV.META_APP_SECRET, redirect_uri: callbackUrl("meta"), code })}`,
    );
    const long = await call(
        `https://graph.facebook.com/${META_VERSION}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: ENV.META_APP_ID, client_secret: ENV.META_APP_SECRET, fb_exchange_token: short.access_token })}`,
    );
    return { accessToken: long.access_token ?? short.access_token };
}

async function metaAccounts(creds) {
    const out = [];
    let url = `https://graph.facebook.com/${META_VERSION}/me/adaccounts?${new URLSearchParams({ fields: "account_id,name,currency,timezone_name", limit: "100", access_token: creds.accessToken })}`;
    for (let i = 0; url && i < 20; i++) {
        const page = await call(url);
        for (const a of page.data ?? []) out.push({ externalAccountId: String(a.account_id), name: a.name || `Meta ${a.account_id}`, currency: a.currency ?? null, timezone: a.timezone_name ?? null });
        url = page.paging?.next ?? null;
    }
    return out;
}

async function metaSpend(creds, account, since, until) {
    const rows = [];
    let url = `https://graph.facebook.com/${META_VERSION}/act_${account.externalAccountId}/insights?${new URLSearchParams({
        level: "campaign",
        fields: "campaign_id,campaign_name,spend,impressions,clicks,date_start",
        time_increment: "1",
        time_range: JSON.stringify({ since, until }),
        limit: "500",
        access_token: creds.accessToken,
    })}`;
    for (let i = 0; url && i < 50; i++) {
        const page = await call(url);
        for (const r of page.data ?? []) {
            rows.push({ date: r.date_start, campaignId: r.campaign_id, campaignName: r.campaign_name || "(none)", spend: r.spend ?? "0", impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0) });
        }
        url = page.paging?.next ?? null;
    }
    return rows;
}

// ── Google Ads ──────────────────────────────────────────────────────────────

async function googleToken(params) {
    return call("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: ENV.GOOGLE_ADS_CLIENT_ID, client_secret: ENV.GOOGLE_ADS_CLIENT_SECRET, ...params }),
    });
}

async function googleExchange(code) {
    const t = await googleToken({ code, grant_type: "authorization_code", redirect_uri: callbackUrl("google") });
    if (!t.refresh_token) throw new AdPlatformError("Google did not return a refresh token. Remove the app's access in your Google account and connect again.", 400);
    return { refreshToken: t.refresh_token };
}

async function googleAccess(creds) {
    const t = await googleToken({ refresh_token: creds.refreshToken, grant_type: "refresh_token" });
    return t.access_token;
}

const googleHeaders = (token, loginCustomerId) => ({
    Authorization: `Bearer ${token}`,
    "developer-token": ENV.GOOGLE_ADS_DEVELOPER_TOKEN,
    "Content-Type": "application/json",
    ...(loginCustomerId ? { "login-customer-id": String(loginCustomerId) } : {}),
});

async function googleSearch(token, customerId, query, loginCustomerId) {
    const chunks = await call(`https://googleads.googleapis.com/${GOOGLE_VERSION}/customers/${customerId}/googleAds:searchStream`, {
        method: "POST",
        headers: googleHeaders(token, loginCustomerId),
        body: JSON.stringify({ query }),
    });
    return (Array.isArray(chunks) ? chunks : [chunks]).flatMap((c) => c?.results ?? []);
}

async function googleAccounts(creds) {
    const token = await googleAccess(creds);
    const list = await call(`https://googleads.googleapis.com/${GOOGLE_VERSION}/customers:listAccessibleCustomers`, { headers: googleHeaders(token) });
    const out = [];
    for (const resource of (list.resourceNames ?? []).slice(0, 50)) {
        const id = resource.split("/")[1];
        try {
            const [row] = await googleSearch(token, id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer");
            if (row?.customer?.manager) continue; // manager accounts hold no spend themselves
            out.push({ externalAccountId: id, name: row?.customer?.descriptiveName || `Google Ads ${id}`, currency: row?.customer?.currencyCode ?? null, timezone: row?.customer?.timeZone ?? null });
        } catch {
            out.push({ externalAccountId: id, name: `Google Ads ${id}`, currency: null, timezone: null });
        }
    }
    return out;
}

async function googleSpend(creds, account, since, until) {
    const token = await googleAccess(creds);
    const results = await googleSearch(
        token,
        account.externalAccountId,
        `SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`,
        creds.loginCustomerId,
    );
    return results.map((r) => ({
        date: r.segments?.date,
        campaignId: String(r.campaign?.id ?? ""),
        campaignName: r.campaign?.name || "(none)",
        // cost_micros: 1,000,000 = one unit of the account currency
        spend: (Number(r.metrics?.costMicros ?? 0) / 1e6).toFixed(6),
        impressions: Number(r.metrics?.impressions ?? 0),
        clicks: Number(r.metrics?.clicks ?? 0),
    }));
}

const PLATFORM = {
    meta: { exchange: metaExchange, accounts: metaAccounts, spend: metaSpend },
    google: { exchange: googleExchange, accounts: googleAccounts, spend: googleSpend },
};

/** OAuth callback: exchange the code, store every accessible ad account (encrypted credentials). */
export async function completeConnection(platform, { code, state }, client = db) {
    const s = verifyState(state, platform);
    const p = PLATFORM[platform];
    if (!p) throw new AdPlatformError("Unknown platform", 400);
    const creds = await p.exchange(String(code ?? ""));
    const accounts = await p.accounts(creds);
    const t = tenantDb(client, s.workspaceId);
    const saved = [];
    for (const a of accounts) {
        const existing = await t.AdAccount.where({ platform, externalAccountId: a.externalAccountId }).first();
        const data = { name: a.name, currency: a.currency, timezone: a.timezone, credentialsEnc: encryptSecret(JSON.stringify(creds)), status: "healthy", lastError: null };
        if (existing) {
            await t.AdAccount.where({ id: existing.id }).update(data);
            saved.push(existing.id);
        } else {
            saved.push((await t.AdAccount.create({ platform, externalAccountId: a.externalAccountId, ...data })).id);
        }
    }
    return { workspaceId: s.workspaceId, userId: s.userId, accounts: saved.length };
}

const isoDay = (d) => d.toISOString().slice(0, 10);

/** Pull spend for one account (default: the last 7 days, which the platforms may still revise). */
export async function syncAccount(workspaceId, accountId, { days = 7, client = db } = {}) {
    const t = tenantDb(client, workspaceId);
    const account = await t.AdAccount.where({ id: accountId }).first();
    if (!account) throw new AdPlatformError("Ad account not found", 404);
    if (account.status === "disabled") return { skipped: "disabled" };
    const p = PLATFORM[account.platform];
    if (!p || !platformConfigured(account.platform)) throw new AdPlatformError(`${account.platform} sync is not configured on this server`, 501);
    let creds;
    try {
        creds = JSON.parse(decryptSecret(account.credentialsEnc));
    } catch {
        throw new AdPlatformError("Stored credentials are unreadable; reconnect the account", 400);
    }
    const until = new Date();
    const since = new Date(until.getTime() - (days - 1) * 86_400_000);
    try {
        const rows = await p.spend(creds, account, isoDay(since), isoDay(until));
        const currency = account.currency || "USD";
        let written = 0;
        for (const r of rows) {
            if (!r.date) continue;
            await upsertSpendRow(t, {
                adAccountId: account.id,
                locationId: null,
                platform: account.platform,
                channel: account.platform === "meta" ? "meta" : "google",
                date: r.date,
                campaignId: r.campaignId || null,
                campaignName: r.campaignName,
                adSetName: null,
                adName: null,
                spendMinorUnits: toMinorUnits(r.spend, currency, "spend"),
                currency,
                impressions: r.impressions,
                clicks: r.clicks,
                source: "api",
            });
            written++;
        }
        await t.AdAccount.where({ id: account.id }).update({ lastSyncedAt: new Date().toISOString(), lastError: null, status: "healthy" });
        return { rows: written };
    } catch (err) {
        await t.AdAccount.where({ id: account.id }).update({ lastError: String(err.message).slice(0, 500), status: "failing" });
        throw err;
    }
}
