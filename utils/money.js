/**
 * Money: integers in minor units + ISO 4217 code (scope 4.11). Never floats in storage.
 */

// ISO 4217 minor-unit exponents that differ from 2.
const EXPONENTS = {
    BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0,
    VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
    BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

export const currencyExponent = (currency) => EXPONENTS[String(currency ?? "").toUpperCase()] ?? 2;

export const isCurrencyCode = (value) => typeof value === "string" && /^[A-Za-z]{3}$/.test(value);

export class MoneyInputError extends Error {
    constructor(message) {
        super(message);
        this.statusCode = 400;
    }
}

/**
 * Major units (number or numeric string, e.g. 19.99 / "19.99") -> BigInt minor units, exact.
 * Decimal strings are parsed digit by digit so 0.1 + 0.2 style float errors cannot creep in.
 */
export function toMinorUnits(amount, currency, field = "amount") {
    if (amount === null || amount === undefined || amount === "") return 0n;
    if (typeof amount === "bigint") return amount * 10n ** BigInt(currencyExponent(currency));
    const exp = currencyExponent(currency);
    const text = typeof amount === "number" ? amountToString(amount) : String(amount).trim();
    const m = text.match(/^(-)?(\d*)(?:\.(\d*))?$/);
    if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new MoneyInputError(`${field} must be a number`);
    const [, sign, whole, frac = ""] = m;
    // round half away from zero on the first dropped digit
    const kept = (frac + "0".repeat(exp)).slice(0, exp);
    const dropped = frac.slice(exp);
    let minor = BigInt((whole || "0") + kept);
    if (dropped && Number(dropped[0]) >= 5) minor += 1n;
    return sign ? -minor : minor;
}

function amountToString(n) {
    if (!Number.isFinite(n)) throw new MoneyInputError("amount must be a finite number");
    // toString may use exponent notation for tiny/huge numbers; toFixed(6) is plenty for money.
    return Math.abs(n) < 1e-6 || Math.abs(n) >= 1e21 ? n.toFixed(6) : String(n);
}

/** Accepts either `<name>MinorUnits` (integer) or `<name>` (major units) from a payload. */
export function readMoney(body, name, currency, { required = false } = {}) {
    const minorKey = `${name}MinorUnits`;
    if (body[minorKey] !== undefined && body[minorKey] !== null) {
        const v = body[minorKey];
        if (typeof v === "bigint") return v;
        if (!/^-?\d+$/.test(String(v))) throw new MoneyInputError(`${minorKey} must be an integer`);
        return BigInt(String(v));
    }
    const major = body[`${name}Amount`] ?? body[name];
    if (major === undefined || major === null || major === "") {
        if (required) throw new MoneyInputError(`${name}Amount is required`);
        return null;
    }
    return toMinorUnits(major, currency, `${name}Amount`);
}

/** BigInt minor units -> major-unit string ("1999" USD -> "19.99"). */
export function formatMinor(minor, currency) {
    const exp = currencyExponent(currency);
    const v = BigInt(minor ?? 0);
    const neg = v < 0n;
    const abs = (neg ? -v : v).toString().padStart(exp + 1, "0");
    const out = exp ? `${abs.slice(0, -exp)}.${abs.slice(-exp)}` : abs;
    return neg ? `-${out}` : out;
}

/** Multiply BigInt minor units by a decimal factor (FX rate, credit share) and round half-up. */
export function scaleMinor(minor, factor) {
    const f = Number(factor);
    if (!Number.isFinite(f)) return null;
    // 1e9 fixed-point keeps 9 decimals of the factor without float drift on large amounts
    const scaled = BigInt(minor) * BigInt(Math.round(f * 1e9));
    const q = scaled / 1_000_000_000n;
    const r = scaled % 1_000_000_000n;
    const half = 500_000_000n;
    if (r >= half) return q + 1n;
    if (r <= -half) return q - 1n;
    return q;
}

/**
 * Split `total` minor units over `shares` (summing to 1) so that the parts are integers that add up
 * EXACTLY to `total` (largest-remainder method). Ties go to the earlier index.
 */
export function allocateMinor(total, shares) {
    const t = BigInt(total);
    if (!shares.length) return [];
    const weights = shares.map((s) => BigInt(Math.round(Number(s) * 1e9)));
    const wsum = weights.reduce((a, b) => a + b, 0n) || 1n;
    const raw = weights.map((w) => t * w);
    const base = raw.map((r) => r / wsum);
    let remainder = t - base.reduce((a, b) => a + b, 0n);
    const order = raw
        .map((r, i) => ({ i, rem: r % wsum }))
        .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
    const out = [...base];
    const step = remainder >= 0n ? 1n : -1n;
    for (let k = 0; remainder !== 0n && k < order.length * 2; k++) {
        const idx = order[k % order.length].i;
        if (weights[idx] === 0n) continue;
        out[idx] += step;
        remainder -= step;
    }
    return out;
}
