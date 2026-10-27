import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "./fakeDb.js";

const { syncLatestRates, findRate } = await import("../services/fx.js");

test("daily FX sync imports a rolling EUR reference history, preserves manual rates, and converts through EUR", async () => {
    const fake = createFakeDb();
    const endDate = new Date().toISOString().slice(0, 10);
    const startDateValue = new Date(`${endDate}T00:00:00.000Z`);
    startDateValue.setUTCDate(startDateValue.getUTCDate() - 45);
    const startDate = startDateValue.toISOString().slice(0, 10);
    fake.tables.FxRate = [
        { id: "manual-rate", date: endDate, base: "EUR", quote: "INR", rate: 100, source: "admin_upload" },
    ];

    let eurUsd = 1.1;
    const fetchImpl = async (input) => {
        const url = new URL(input);
        assert.equal(url.pathname, `/v1/${startDate}..${endDate}`);
        assert.equal(url.searchParams.get("base"), "EUR");
        return {
            ok: true,
            status: 200,
            json: async () => ({
                start_date: startDate,
                end_date: endDate,
                base: "EUR",
                rates: {
                    [startDate]: { INR: 90, USD: eurUsd },
                    [endDate]: { INR: 91, USD: eurUsd },
                },
            }),
        };
    };

    const result = await syncLatestRates(fake.db.orm.public, fetchImpl);
    assert.deepEqual(result, {
        startDate,
        date: endDate,
        currencies: ["EUR", "INR", "USD"],
        written: 3,
        preserved: 1,
    });
    assert.equal(fake.tables.FxRate.find((row) => row.id === "manual-rate").rate, 100);
    assert.equal(await findRate(fake.db.orm.public, endDate, "INR", "USD"), 1.1 / 100);
    assert.equal(await findRate(fake.db.orm.public, endDate, "USD", "INR"), 100 / 1.1);
    assert.equal(await findRate(fake.db.orm.public, startDate, "INR", "USD"), 1.1 / 90);

    eurUsd = 1.2;
    const refreshed = await syncLatestRates(fake.db.orm.public, fetchImpl);
    assert.equal(refreshed.written, 2);
    assert.equal(refreshed.preserved, 1);
    assert.equal(await findRate(fake.db.orm.public, endDate, "USD", "INR"), 100 / 1.2);
    assert.equal(fake.tables.FxRate.find((row) => row.id === "manual-rate").rate, 100);
});

test("daily FX sync surfaces provider failures", async () => {
    const fake = createFakeDb();
    const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });

    await assert.rejects(syncLatestRates(fake.db.orm.public, fetchImpl), /HTTP 503/);
});
