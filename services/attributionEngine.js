/**
 * Attribution Engine
 *
 * Computes AttributionCredit rows for all 6 models and writes them
 * transactionally with the order or booking.
 *
 * Models:
 *   first_touch      – 100% to the first touch
 *   last_touch       – 100% to the last touch
 *   last_non_direct  – 100% to the last non-direct touch; falls back to last_touch
 *   linear           – equal credit to all touches
 *   time_decay       – exponential decay; more recent = more credit (half-life 7 days)
 *   position_based   – 40% first, 40% last, 20% divided among middle
 */

const DIRECT_CHANNELS = new Set(["direct", "", null, undefined]);
const HALF_LIFE_DAYS = 7;

/**
 * Classifies a touch into a channel using channel mapping rules or UTM data.
 * Returns a string channel name.
 */
export function classifyChannel(touch, mappingRules = []) {
    // Apply workspace channel mapping rules (by priority)
    const sorted = [...mappingRules].sort((a, b) => a.priority - b.priority);
    for (const rule of sorted) {
        if (!rule.isActive) continue;
        try {
            const match = rule.match;
            if (matchesRule(touch, match)) return rule.channel;
        } catch {
            // malformed rule — skip
        }
    }
    // Default UTM-based classification
    if (touch.gclid || touch.source?.toLowerCase().includes("google")) return "google";
    if (touch.fbclid || touch.source?.toLowerCase().includes("facebook") || touch.source?.toLowerCase().includes("instagram")) return "meta";
    if (touch.ttclid) return "tiktok";
    if (touch.msclkid) return "bing";
    if (touch.medium?.toLowerCase() === "email") return "email";
    if (touch.medium?.toLowerCase() === "social") return "social";
    if (touch.medium?.toLowerCase() === "cpc" || touch.medium?.toLowerCase() === "paid") return "paid_search";
    if (touch.medium?.toLowerCase() === "organic" || !touch.source && touch.referrer) return "organic";
    if (!touch.source && !touch.medium && !touch.referrer) return "direct";
    return touch.source || "other";
}

function matchesRule(touch, match) {
    for (const [field, value] of Object.entries(match)) {
        const touchVal = String(touch[field] ?? "").toLowerCase();
        const matchVal = String(value).toLowerCase();
        if (!touchVal.includes(matchVal)) return false;
    }
    return true;
}

/**
 * Filters touches inside the lookback window, applies priority ordering,
 * and removes any direct touch if a paid click exists in the window.
 */
export function filterTouches(touches, lookbackDays = 30, orderedAt, overrides = {}) {
    if (!touches || touches.length === 0) return [];
    const cutoff = new Date(new Date(orderedAt).getTime() - lookbackDays * 86400 * 1000);

    // Filter to lookback window
    let inWindow = touches.filter(t => new Date(t.touchedAt) >= cutoff && new Date(t.touchedAt) <= new Date(orderedAt));

    if (inWindow.length === 0) return [];

    // Sort by time ascending
    inWindow.sort((a, b) => new Date(a.touchedAt) - new Date(b.touchedAt));

    // If there's any paid click, suppress later direct touches
    const hasPaidClick = inWindow.some(t => t.gclid || t.fbclid || t.ttclid || t.msclkid);
    if (hasPaidClick) {
        inWindow = inWindow.filter(t => {
            const ch = t.channel || "";
            return !DIRECT_CHANNELS.has(ch.toLowerCase());
        });
        if (inWindow.length === 0) {
            // Shouldn't happen but fall back to all touches
            inWindow = touches.filter(t => new Date(t.touchedAt) >= cutoff);
        }
    }

    return inWindow;
}

/**
 * Computes fractional shares [0..1] summing to 1 for all 6 models.
 * Returns: { first_touch, last_touch, last_non_direct, linear, time_decay, position_based }
 *   each being an array of shares aligned with the `touches` parameter.
 */
export function computeShares(touches, orderedAt) {
    const n = touches.length;
    if (n === 0) return null;

    const result = {};

    // ── first_touch ──────────────────────────────────────────────────
    result.first_touch = touches.map((_, i) => (i === 0 ? 1.0 : 0.0));

    // ── last_touch ───────────────────────────────────────────────────
    result.last_touch = touches.map((_, i) => (i === n - 1 ? 1.0 : 0.0));

    // ── last_non_direct ──────────────────────────────────────────────
    let lastNonDirectIdx = -1;
    for (let i = n - 1; i >= 0; i--) {
        const ch = (touches[i].channel || "").toLowerCase();
        if (!DIRECT_CHANNELS.has(ch)) { lastNonDirectIdx = i; break; }
    }
    if (lastNonDirectIdx === -1) lastNonDirectIdx = n - 1; // fall back to last
    result.last_non_direct = touches.map((_, i) => (i === lastNonDirectIdx ? 1.0 : 0.0));

    // ── linear ───────────────────────────────────────────────────────
    result.linear = touches.map(() => 1.0 / n);

    // ── time_decay ───────────────────────────────────────────────────
    const now = new Date(orderedAt).getTime();
    const halfLifeMs = HALF_LIFE_DAYS * 86400 * 1000;
    const raw = touches.map(t => Math.pow(2, -(now - new Date(t.touchedAt).getTime()) / halfLifeMs));
    const sumRaw = raw.reduce((a, b) => a + b, 0);
    result.time_decay = raw.map(w => w / sumRaw);

    // ── position_based (40/20/40) ────────────────────────────────────
    if (n === 1) {
        result.position_based = [1.0];
    } else if (n === 2) {
        result.position_based = [0.5, 0.5];
    } else {
        const middle = n - 2;
        const middleShare = 0.2 / middle;
        result.position_based = touches.map((_, i) => {
            if (i === 0) return 0.4;
            if (i === n - 1) return 0.4;
            return middleShare;
        });
    }

    return result;
}

/**
 * Builds AttributionCredit rows (one per touch per model) ready to be bulk-inserted.
 * `netMinorUnits` and `currency` are the order/booking values.
 */
export function buildCreditRows({
    workspaceId,
    orderId = null,
    bookingId = null,
    touches,
    orderedAt,
    netMinorUnits,
    currency,
}) {
    if (!touches || touches.length === 0) {
        // Unattributed — write one "none" row for each model
        const models = ["first_touch", "last_touch", "last_non_direct", "linear", "time_decay", "position_based"];
        return models.map(model => ({
            workspaceId,
            orderId,
            bookingId,
            touchId: null,
            model,
            share: 1.0,
            amountMinorUnits: BigInt(netMinorUnits),
            currency,
        }));
    }

    const shares = computeShares(touches, orderedAt);
    const rows = [];

    for (const [model, shareArr] of Object.entries(shares)) {
        for (let i = 0; i < touches.length; i++) {
            const share = shareArr[i];
            if (share <= 0) continue;
            rows.push({
                workspaceId,
                orderId,
                bookingId,
                touchId: touches[i].id,
                model,
                share,
                amountMinorUnits: BigInt(Math.round(Number(netMinorUnits) * share)),
                currency,
            });
        }
    }

    return rows;
}
