/**
 * Company settings: one validator for every place that changes them (company admin settings page,
 * platform admin console), and the rebuild rules from scope 4.7:
 *   "Rollups are rebuilt automatically when timezone, currency or model settings change."
 * Attribution itself depends on the lookback window and channel mapping, so changing those re-runs
 * attribution first (credits are recomputed from the stored, never-overwritten touches) and then
 * rebuilds the rollups.
 */

import { isValidTimeZone } from "../utils/timezone.js";
import { ATTRIBUTION_MODELS } from "./attributionEngine.js";
import { enqueueJob } from "./jobs.js";
import { requestRebuild, invalidateRollups } from "./rollups.js";

const CONSENT_MODES = ["off", "opt_in", "opt_out"];

/** @returns {string|null} a message describing the first invalid setting */
export function validateWorkspaceSettings(changes) {
    if ("name" in changes && (typeof changes.name !== "string" || !changes.name.trim())) return "name cannot be empty";
    if ("timezone" in changes && !isValidTimeZone(changes.timezone)) return "timezone must be an IANA timezone name, e.g. Asia/Kolkata";
    if ("reportingCurrency" in changes) {
        if (!/^[A-Za-z]{3}$/.test(String(changes.reportingCurrency ?? ""))) return "reportingCurrency must be a 3-letter ISO code";
        changes.reportingCurrency = String(changes.reportingCurrency).toUpperCase();
    }
    if ("country" in changes) {
        if (!/^[A-Za-z]{2}$/.test(String(changes.country ?? ""))) return "country must be a 2-letter ISO code";
        changes.country = String(changes.country).toUpperCase();
    }
    if ("weekStart" in changes) {
        const w = Number(changes.weekStart);
        if (!Number.isInteger(w) || w < 0 || w > 6) return "weekStart must be 0 (Sunday) to 6 (Saturday)";
        changes.weekStart = w;
    }
    if ("defaultModel" in changes && !ATTRIBUTION_MODELS.includes(changes.defaultModel)) {
        return `defaultModel must be one of: ${ATTRIBUTION_MODELS.join(", ")}`;
    }
    if ("lookbackDays" in changes) {
        const d = Number(changes.lookbackDays);
        if (!Number.isInteger(d) || d < 1 || d > 365) return "lookbackDays must be a whole number from 1 to 365";
        changes.lookbackDays = d;
    }
    if ("lookbackOverrides" in changes && changes.lookbackOverrides !== null) {
        const o = changes.lookbackOverrides;
        if (typeof o !== "object" || Array.isArray(o)) return "lookbackOverrides must be an object like { \"email\": 7 }";
        for (const [channel, days] of Object.entries(o)) {
            if (!channel || channel.length > 64) return "lookbackOverrides has an invalid channel name";
            if (!Number.isInteger(days) || days < 1 || days > 365) return `lookbackOverrides.${channel} must be 1 to 365 days`;
        }
    }
    if ("consentMode" in changes && !CONSENT_MODES.includes(changes.consentMode)) return `consentMode must be one of: ${CONSENT_MODES.join(", ")}`;
    if ("rawRetentionMonths" in changes) {
        const m = Number(changes.rawRetentionMonths);
        if (!Number.isInteger(m) || m < 1 || m > 120) return "rawRetentionMonths must be 1 to 120";
        changes.rawRetentionMonths = m;
    }
    if ("taxIncludedInRevenue" in changes && typeof changes.taxIncludedInRevenue !== "boolean") return "taxIncludedInRevenue must be true or false";
    if ("websiteUrl" in changes && changes.websiteUrl !== null) {
        try {
            const u = new URL(String(changes.websiteUrl));
            if (!["http:", "https:"].includes(u.protocol)) throw new Error();
        } catch {
            return "websiteUrl must be a full http(s) URL";
        }
    }
    return null;
}

const REATTRIBUTE_ON = new Set(["lookbackDays", "lookbackOverrides", "channelRules"]);
const REBUILD_ON = new Set(["timezone", "reportingCurrency", "defaultModel", "taxIncludedInRevenue", "weekStart"]);

/** Queue the background work a settings change requires. Returns what was queued. */
export async function scheduleRebuildIfNeeded(workspaceId, changedKeys, actorUserId = null) {
    const keys = new Set(changedKeys);
    if ([...keys].some((k) => REATTRIBUTE_ON.has(k))) {
        await invalidateRollups(workspaceId); // past credits are about to change
        enqueueJob("attribution.rerun", { workspaceId, actorUserId, reason: "settings_changed" });
        return "attribution.rerun";
    }
    if ([...keys].some((k) => REBUILD_ON.has(k))) {
        await requestRebuild(workspaceId, "settings_changed");
        return "rollups.rebuild";
    }
    return null;
}
