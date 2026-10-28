import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "./fakeDb.js";

const { syncLatestRates, findRate, FX_BASE } = await import("../services/fx.js");

const isoDaysAgo = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
};

/** Fake public APIs: Frankfurter (USD base, ECB set) and the secondary currency-api (USD base, 150+). */
function providers({ ecb, secondary = null, secondaryFails = false }) {
    const calls = [];
    const fetchImpl = async (input) => {
        const url = new URL(input);
        calls.push(url.href);
        if (url.hostname === "api.frankfurter.dev") {
            return { ok: true, status: 200, json: async () => ecb() };
        }
        if (secondaryFails) return { ok: false, status: 503, json: async () => ({}) };
        const latest = url.pathname.includes("@latest") || url.hostname.startsWith("latest.");
        const body = latest && secondary ? secondary() : null;
        if (!body) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => body };
    };
    return { fetchImpl, calls };
}

test("rates are fetched with USD as the base, manual rates are preserved, and crosses go through USD", async () => {
    const fake = createFakeDb();
    const end = isoDaysAgo(0);
    const start = isoDaysAgo(45);
    fake.tables.FxRate = [{ id: "manual-rate", date: end, base: "USD", quote: "INR", rate: 84, source: "admin_upload" }];
    let usdEur = 0.9;
    const { fetchImpl, calls } = providers({
        ecb: () => ({ base: "USD", start_date: start, end_date: end, rates: { [start]: { INR: 83, EUR: usdEur }, [end]: { INR: 83.5, EUR: usdEur } } }),
    });

    const result = await syncLatestRates(fake.db.orm.public, fetchImpl, { secondary: false });
    assert.equal(FX_BASE, "USD");
    assert.equal(result.base, "USD");
    assert.match(calls[0], new RegExp(`/v1/${start}\\.\\.${end}\\?base=USD$`));
    assert.equal(result.written, 3, "INR on the start day, EUR on both days");
    assert.equal(result.preserved, 1, "the manual INR rate of today wins");
    assert.deepEqual(result.changedDates, [start, end]);
    assert.deepEqual(result.currencies, ["EUR", "INR", "USD"]);
    assert.equal(fake.tables.FxRate.find((row) => row.id === "manual-rate").rate, 84);

    assert.equal(await findRate(fake.db.orm.public, end, "USD", "INR"), 84);
    assert.equal(await findRate(fake.db.orm.public, start, "INR", "USD"), 1 / 83);
    // EUR → INR has no direct row: derived through USD
    assert.ok(Math.abs((await findRate(fake.db.orm.public, end, "EUR", "INR")) - 84 / 0.9) < 1e-9);

    usdEur = 0.92;
    const refreshed = await syncLatestRates(fake.db.orm.public, fetchImpl, { secondary: false });
    assert.equal(refreshed.written, 2);
    assert.deepEqual(refreshed.changedDates, [start, end]);
});

test("currencies the ECB does not publish (AED, SAR) come from the second public source, never overriding the ECB", async () => {
    const fake = createFakeDb();
    const end = isoDaysAgo(0);
    const start = isoDaysAgo(45);
    const { fetchImpl } = providers({
        ecb: () => ({ base: "USD", start_date: start, end_date: end, rates: { [end]: { INR: 83, EUR: 0.9 } } }),
        // the secondary source also lists INR (ignored: the ECB covers it) and a crypto code (ignored)
        secondary: () => ({ date: end, usd: { aed: 3.6725, sar: 3.75, inr: 99, btc: 0.00001, usd: 1 } }),
    });
    const result = await syncLatestRates(fake.db.orm.public, fetchImpl);
    assert.equal(result.secondary.error, null);
    assert.ok(result.currencies.includes("AED") && result.currencies.includes("SAR"));
    assert.equal(await findRate(fake.db.orm.public, end, "USD", "AED"), 3.6725);
    assert.equal(await findRate(fake.db.orm.public, end, "USD", "INR"), 83, "ECB rate kept, secondary 99 ignored");
    assert.ok(!fake.tables.FxRate.some((r) => r.quote === "BTC"));
    // AED → INR: cross through USD
    assert.ok(Math.abs((await findRate(fake.db.orm.public, end, "AED", "INR")) - 83 / 3.6725) < 1e-9);
    const aed = fake.tables.FxRate.find((r) => r.quote === "AED");
    assert.equal(aed.source, "currency-api");
});

test("a failing second source never fails the sync: the ECB rates are still stored", async () => {
    const fake = createFakeDb();
    const end = isoDaysAgo(0);
    const { fetchImpl } = providers({
        ecb: () => ({ base: "USD", start_date: isoDaysAgo(45), end_date: end, rates: { [end]: { INR: 83 } } }),
        secondaryFails: true,
    });
    const result = await syncLatestRates(fake.db.orm.public, fetchImpl);
    assert.match(result.secondary.error, /secondary FX source unavailable/);
    assert.equal(await findRate(fake.db.orm.public, end, "USD", "INR"), 83);
});

test("rates stored before the switch to USD (EUR base) still convert, through EUR", async () => {
    const fake = createFakeDb();
    const d = isoDaysAgo(60);
    fake.tables.FxRate = [
        { id: "1", date: d, base: "EUR", quote: "INR", rate: 90, source: "frankfurter" },
        { id: "2", date: d, base: "EUR", quote: "USD", rate: 1.1, source: "frankfurter" },
    ];
    assert.ok(Math.abs((await findRate(fake.db.orm.public, d, "USD", "INR")) - 90 / 1.1) < 1e-9);
});

test("FX sync surfaces failures of the main provider", async () => {
    const fake = createFakeDb();
    const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(syncLatestRates(fake.db.orm.public, fetchImpl), /HTTP 503/);
});
