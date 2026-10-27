import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.VERCEL = "1";

const { default: ENV } = await import("../utils/env.js");
const { databasePool, closeDatabase } = await import("../src/prisma/db.js");

after(async () => {
    await closeDatabase();
});

test("Vercel functions disable background workers and use a single database connection", () => {
    assert.equal(ENV.DISABLE_BACKGROUND_WORKERS, true);
    assert.equal(databasePool.options.max, 1);
    assert.equal(databasePool.options.connectionTimeoutMillis, 10_000);
    assert.equal(databasePool.options.idleTimeoutMillis, 10_000);
});
