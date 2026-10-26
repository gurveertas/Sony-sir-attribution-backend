/**
 * Attribution engine (scope 4.6, DFD process 6.0). Pure functions — no database access — so the
 * live pipeline, the re-run tool and replays all compute credit exactly the same way.
 *
 * Models:
 *   first_touch      100% to the first touch
 *   last_touch       100% to the last touch
 *   last_non_direct  100% to the last non-direct touch, else the last touch   (company default)
 *   linear           equal shares
 *   time_decay       exponential decay towards the conversion (half-life 7 days)
 *   position_based   40% first, 40% last, 20% split over the middle (two touches: 50/50)
 *
 * Touch priority: click-ID touch > UTM touch > referrer-only touch > direct. Within one visit
 * (30 minutes) only the highest-priority touch counts, and a later direct visit never replaces a
 * paid click or campaign touch.
 */

import { allocateMinor } from "../utils/money.js";

export const ATTRIBUTION_MODELS = ["first_touch", "last_touch", "last_non_direct", "linear", "time_decay", "position_based"];
export const DEFAULT_MODEL = "last_non_direct";
export const UNATTRIBUTED_CHANNEL = "direct_unknown";
export const DIRECT_CHANNEL = "direct";

const HALF_LIFE_DAYS = 7;
const SAME_VISIT_MS = 30 * 60 * 1000;
const DAY_MS = 86_400_000;

// ── Channel classification ──────────────────────────────────────────────────

const PAID_MEDIUMS = new Set(["cpc", "ppc", "paid", "paidsearch", "paid_search", "paid-search", "cpm", "display", "paid_social", "paidsocial", "paid-social", "ads", "ad", "cpv", "retargeting"]);
const SEARCH_HOSTS = ["google.", "bing.", "yahoo.", "duckduckgo.", "baidu.", "yandex.", "ecosia.", "search.brave."];
const SOCIAL_HOSTS = ["facebook.", "instagram.", "t.co", "twitter.", "x.com", "linkedin.", "lnkd.in", "pinterest.", "reddit.", "tiktok.", "youtube.", "l.facebook.", "lm.facebook."];

const PLATFORM_BY_SOURCE = [
    [/^(google|adwords|gads|youtube)/, "google"],
    [/^(facebook|fb|instagram|ig|meta|messenger)/, "meta"],
    [/^tiktok/, "tiktok"],
    [/^(bing|microsoft|msn)/, "bing"],
    [/^(linkedin)/, "linkedin"],
    [/^(snapchat|snap)$/, "snapchat"],
];

const lower = (v) => String(v ?? "").trim().toLowerCase();

function hostOf(url) {
    try {
        return new URL(String(url)).hostname.toLowerCase();
    } catch {
        return "";
    }
}

export const hasClickId = (t) => Boolean(t.gclid || t.fbclid || t.ttclid || t.msclkid || t.gbraid || t.wbraid);
const hasUtm = (t) => Boolean(t.source || t.medium || t.campaign);

/** 3 click ID, 2 UTM, 1 referrer only, 0 direct. */
export function touchPriority(t) {
    if (hasClickId(t)) return 3;
    if (hasUtm(t)) return 2;
    if (t.referrer && !isInternalReferrer(t)) return 1;
    return 0;
}

export function isInternalReferrer(t) {
    const ref = hostOf(t.referrer);
    const land = hostOf(t.landingPage);
    return Boolean(ref && land && (ref === land || ref.endsWith(`.${land}`) || land.endsWith(`.${ref}`)));
}

function matchesRule(touch, match) {
    if (!match || typeof match !== "object") return false;
    const entries = Object.entries(match);
    if (!entries.length) return false;
    for (const [field, expected] of entries) {
        const actual = lower(field === "referrerHost" ? hostOf(touch.referrer) : touch[field]);
        if (expected && typeof expected === "object") {
            if ("equals" in expected && actual !== lower(expected.equals)) return false;
            if ("contains" in expected && !actual.includes(lower(expected.contains))) return false;
            if ("present" in expected && Boolean(actual) !== Boolean(expected.present)) return false;
        } else if (!actual.includes(lower(expected))) {
            return false;
        }
    }
    return true;
}

/**
 * Channel for a touch. Company channel-mapping rules (lowest priority number first) win; otherwise
 * the default taxonomy below is used. Rule `match` example: {"source": "newsletter", "medium": {"equals": "email"}}.
 */
export function classifyChannel(touch, mappingRules = []) {
    const rules = [...(mappingRules || [])].filter((r) => r && r.isActive !== false).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    for (const rule of rules) {
        try {
            if (matchesRule(touch, rule.match)) return String(rule.channel);
        } catch {
            /* malformed rule: skip */
        }
    }

    // 1. click IDs identify the ad platform unambiguously
    if (touch.gclid || touch.gbraid || touch.wbraid) return "google";
    if (touch.fbclid) return "meta";
    if (touch.ttclid) return "tiktok";
    if (touch.msclkid) return "bing";

    const source = lower(touch.source);
    const medium = lower(touch.medium);

    // 2. UTM-tagged traffic
    if (source || medium) {
        if (["email", "e-mail", "newsletter"].includes(medium) || source === "newsletter") return "email";
        if (["affiliate", "affiliates", "partner"].includes(medium)) return "affiliate";
        if (["sms", "whatsapp"].includes(medium)) return "sms";
        const platform = PLATFORM_BY_SOURCE.find(([re]) => re.test(source))?.[1];
        if (medium === "organic") return platform === "google" || platform === "bing" ? "organic_search" : platform ? "organic_social" : "organic_search";
        if (["social", "social-network", "social-media", "sm", "organic_social"].includes(medium)) return "organic_social";
        if (medium === "referral") return "referral";
        if (platform) return platform; // tagged link from a known ad platform (paid or medium unknown)
        if (PAID_MEDIUMS.has(medium)) return "paid_other";
        return source || "other";
    }

    // 3. referrer only
    if (touch.referrer && !isInternalReferrer(touch)) {
        const host = hostOf(touch.referrer);
        if (SEARCH_HOSTS.some((h) => host.includes(h))) return "organic_search";
        if (SOCIAL_HOSTS.some((h) => host === h || host.includes(h))) return "organic_social";
        return host ? "referral" : DIRECT_CHANNEL;
    }

    // 4. nothing known
    return DIRECT_CHANNEL;
}

export const isDirect = (channel) => !channel || channel === DIRECT_CHANNEL || channel === UNATTRIBUTED_CHANNEL;

// ── Touch selection ─────────────────────────────────────────────────────────

/**
 * Keep the touches that may receive credit for a conversion at `at`:
 *   - inside the lookback window (default `lookbackDays`; per-channel overrides, e.g. {"email": 7})
 *   - not after the conversion
 *   - one touch per visit (highest priority wins), and direct visits after a click/campaign touch dropped
 * Returns touches sorted oldest first.
 */
export function filterTouches(touches, lookbackDays = 30, at, overrides = {}) {
    if (!touches?.length) return [];
    const atMs = new Date(at).getTime();
    const ov = overrides && typeof overrides === "object" ? overrides : {};

    const inWindow = touches
        .filter((t) => {
            const ms = new Date(t.touchedAt).getTime();
            if (!Number.isFinite(ms) || ms > atMs) return false;
            const days = Number.isInteger(ov[t.channel]) ? ov[t.channel] : lookbackDays;
            return atMs - ms <= days * DAY_MS;
        })
        .sort((a, b) => new Date(a.touchedAt) - new Date(b.touchedAt) || String(a.id).localeCompare(String(b.id)));

    // de-duplicate by id (the same touch can arrive through two visitors after a merge)
    const seen = new Set();
    const unique = inWindow.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));

    // one touch per visit: a lower-priority touch within 30 minutes of a higher one is the same visit
    const collapsed = [];
    for (const t of unique) {
        const prev = collapsed[collapsed.length - 1];
        if (prev && new Date(t.touchedAt) - new Date(prev.touchedAt) <= SAME_VISIT_MS) {
            if (touchPriority(t) > touchPriority(prev)) collapsed[collapsed.length - 1] = t;
            else if (touchPriority(t) === touchPriority(prev) && (t.channel !== prev.channel || t.campaign !== prev.campaign)) collapsed.push(t);
            continue;
        }
        collapsed.push(t);
    }

    // a later direct visit never replaces a paid click / campaign touch
    let sawMarketing = false;
    return collapsed.filter((t) => {
        if (touchPriority(t) >= 2) sawMarketing = true;
        return !(sawMarketing && isDirect(t.channel) && touchPriority(t) === 0);
    });
}

// ── Credit shares ───────────────────────────────────────────────────────────

/** Shares (each array sums to 1) for every model, aligned with `touches` (oldest first). */
export function computeShares(touches, at) {
    const n = touches.length;
    if (n === 0) return null;
    const result = {};

    result.first_touch = touches.map((_, i) => (i === 0 ? 1 : 0));
    result.last_touch = touches.map((_, i) => (i === n - 1 ? 1 : 0));

    let lnd = -1;
    for (let i = n - 1; i >= 0; i--) {
        if (!isDirect(touches[i].channel)) {
            lnd = i;
            break;
        }
    }
    if (lnd === -1) lnd = n - 1;
    result.last_non_direct = touches.map((_, i) => (i === lnd ? 1 : 0));

    result.linear = touches.map(() => 1 / n);

    const atMs = new Date(at).getTime();
    const halfLifeMs = HALF_LIFE_DAYS * DAY_MS;
    const raw = touches.map((t) => Math.pow(2, -Math.max(0, atMs - new Date(t.touchedAt).getTime()) / halfLifeMs));
    const sum = raw.reduce((a, b) => a + b, 0) || 1;
    result.time_decay = raw.map((w) => w / sum);

    if (n === 1) result.position_based = [1];
    else if (n === 2) result.position_based = [0.5, 0.5];
    else result.position_based = touches.map((_, i) => (i === 0 || i === n - 1 ? 0.4 : 0.2 / (n - 2)));

    return result;
}

/**
 * AttributionCredit rows for every model. Amounts are split with the largest-remainder method so
 * the credits of one model always add up EXACTLY to the order (or booking) value.
 * No touches -> one "Direct / unknown" row per model carrying `reasonCode`.
 */
export function buildCreditRows({
    workspaceId,
    orderId = null,
    bookingId = null,
    touches,
    orderedAt,
    netMinorUnits,
    currency,
    reasonCode = "no_source_found",
}) {
    const total = BigInt(netMinorUnits ?? 0);
    if (!touches?.length) {
        return ATTRIBUTION_MODELS.map((model) => ({
            workspaceId,
            orderId,
            bookingId,
            touchId: null,
            model,
            share: 1,
            amountMinorUnits: total,
            currency,
            channel: UNATTRIBUTED_CHANNEL,
            campaign: null,
            reasonCode,
        }));
    }

    const shares = computeShares(touches, orderedAt);
    const rows = [];
    for (const model of ATTRIBUTION_MODELS) {
        const arr = shares[model];
        const amounts = allocateMinor(total, arr);
        touches.forEach((t, i) => {
            if (arr[i] <= 0) return;
            rows.push({
                workspaceId,
                orderId,
                bookingId,
                touchId: t.id,
                model,
                share: Math.round(arr[i] * 1e9) / 1e9,
                amountMinorUnits: amounts[i],
                currency,
                channel: t.channel || DIRECT_CHANNEL,
                campaign: t.campaign ?? null,
                reasonCode: null,
            });
        });
    }
    return rows;
}
