/**
 * Timezone helpers: "a day" is the COMPANY's local day (IANA timezone), never the server's or UTC's.
 *
 * Everything is built on Intl, so daylight-saving changes are handled by the platform's tz database:
 * a local day can be 23, 24 or 25 hours long and its boundaries are always local midnight.
 */

const formatters = new Map();

function formatter(timeZone) {
    let f = formatters.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
        formatters.set(timeZone, f);
    }
    return f;
}

export function isValidTimeZone(timeZone) {
    if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return false;
    try {
        formatter(timeZone);
        return true;
    } catch {
        return false;
    }
}

/** Local wall-clock parts of an instant in a timezone. */
export function localParts(date, timeZone) {
    const out = {};
    for (const { type, value } of formatter(timeZone).formatToParts(date)) {
        if (type !== "literal") out[type] = Number(value);
    }
    return { y: out.year, m: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

/** Offset (ms) of the timezone from UTC at a given instant: local = utc + offset. */
function offsetMs(utcMs, timeZone) {
    const p = localParts(new Date(utcMs), timeZone);
    const wallAsUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    return wallAsUtc - (utcMs - (((utcMs % 1000) + 1000) % 1000));
}

/** The UTC instant at which local midnight of calendar day y-m-d starts in the timezone. */
export function localMidnightUtc({ y, m, d }, timeZone) {
    const guess = Date.UTC(y, m - 1, d);
    const first = guess - offsetMs(guess, timeZone);
    // re-evaluate the offset at the candidate: fixes days on which the offset changes
    return guess - offsetMs(first, timeZone);
}

export function addDays({ y, m, d }, days) {
    const t = new Date(Date.UTC(y, m - 1, d + days));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** "YYYY-MM-DD" of an instant in the timezone. */
export function localDateString(date, timeZone) {
    const { y, m, d } = localParts(date, timeZone);
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses a strict calendar date ("2026-03-08"); returns null for anything else (including 2026-02-30). */
export function parseDateOnly(value) {
    const match = DATE_ONLY.exec(String(value ?? "").trim());
    if (!match) return null;
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
    return { y, m, d };
}

export class RangeInputError extends Error {
    constructor(message) {
        super(message);
        this.name = "RangeInputError";
        this.statusCode = 400;
    }
}

/**
 * Resolves report query params into an inclusive [fromDate, toDate] range of UTC instants.
 *
 *   from / to   "YYYY-MM-DD"  -> whole LOCAL days (from = local midnight, to = last millisecond of that local day)
 *               full ISO instant (with Z / offset) -> used exactly as given
 *   missing     the last `defaultDays` local days ending today (today included)
 */

/** One range end: "YYYY-MM-DD" = whole local day (start or end of it); a full ISO instant is used as given. */
export function parseBoundary(value, name, edge, timeZone) {
    const day = parseDateOnly(value);
    if (day) {
        return edge === "start"
            ? new Date(localMidnightUtc(day, timeZone))
            : new Date(localMidnightUtc(addDays(day, 1), timeZone) - 1);
    }
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) {
        throw new RangeInputError(`${name} must be a date (YYYY-MM-DD) or an ISO-8601 timestamp`);
    }
    return instant;
}

/**
 * Resolves report query params into an inclusive [fromDate, toDate] range of UTC instants.
 *
 *   from / to   "YYYY-MM-DD"  -> whole LOCAL days (from = local midnight, to = last millisecond of that local day)
 *               full ISO instant (with Z / offset) -> used exactly as given
 *   missing     the last `defaultDays` local days ending today (today included)
 */
export function resolveDateRange({ from, to, timeZone, now = new Date(), defaultDays = 30 }) {
    if (!isValidTimeZone(timeZone)) throw new RangeInputError("tz must be a valid IANA timezone, e.g. Asia/Kolkata");

    const today = localParts(now, timeZone);
    const fromDate = from
        ? parseBoundary(from, "from", "start", timeZone)
        : new Date(localMidnightUtc(addDays(today, -(defaultDays - 1)), timeZone));
    const toDate = to ? parseBoundary(to, "to", "end", timeZone) : new Date(localMidnightUtc(addDays(today, 1), timeZone) - 1);

    if (fromDate > toDate) throw new RangeInputError("from must not be after to");
    return { fromDate, toDate };
}

/**
 * Like resolveDateRange but for LIST endpoints: only the ends that were supplied are applied
 * (no default window), so listing without dates still returns everything.
 */
export function resolveOpenRange({ from, to, timeZone }) {
    if (!isValidTimeZone(timeZone)) throw new RangeInputError("tz must be a valid IANA timezone, e.g. Asia/Kolkata");
    const fromDate = from ? parseBoundary(from, "from", "start", timeZone) : null;
    const toDate = to ? parseBoundary(to, "to", "end", timeZone) : null;
    if (fromDate && toDate && fromDate > toDate) throw new RangeInputError("from must not be after to");
    return { fromDate, toDate };
}
