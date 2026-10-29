import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { makeRes, createFakeDb } from "./fakeDb.js";
import { requireMinimumPlan, requireModelAllowed, requireFeature } from "../middlewares/planGuards.js";
import { subscriptionGracePeriodSweep } from "../services/workers.js";

test("requireMinimumPlan allows equal or higher tiers and rejects lower tiers with 403", async () => {
    const middleware = requireMinimumPlan("pro");

    // Case 1: Free tier -> 403 Forbidden
    const freeReq = {
        workspaceId: "ws_free",
        workspace: { id: "ws_free", plan: "free" },
    };
    const res1 = makeRes();
    let nextCalled1 = false;
    await middleware(freeReq, res1, () => { nextCalled1 = true; });
    assert.equal(nextCalled1, false);
    assert.equal(res1.statusCode, 403);
    assert.equal(res1.body.code, "upgrade_required");

    // Case 2: Pro tier -> next() called
    const proReq = {
        workspaceId: "ws_pro",
        workspace: { id: "ws_pro", plan: "pro" },
    };
    const res2 = makeRes();
    let nextCalled2 = false;
    await middleware(proReq, res2, () => { nextCalled2 = true; });
    assert.equal(nextCalled2, true);

    // Case 3: Ultra tier -> next() called
    const ultraReq = {
        workspaceId: "ws_ultra",
        workspace: { id: "ws_ultra", plan: "ultra" },
    };
    const res3 = makeRes();
    let nextCalled3 = false;
    await middleware(ultraReq, res3, () => { nextCalled3 = true; });
    assert.equal(nextCalled3, true);
});

test("requireModelAllowed gates attribution models by workspace plan", async () => {
    // Pro plan requesting data_driven -> 403 (needs Ultra)
    const req1 = {
        workspaceId: "ws1",
        workspace: { id: "ws1", plan: "pro" },
        query: { model: "data_driven" },
    };
    const res1 = makeRes();
    let next1 = false;
    await requireModelAllowed(req1, res1, () => { next1 = true; });
    assert.equal(next1, false);
    assert.equal(res1.statusCode, 403);
    assert.equal(res1.body.code, "model_upgrade_required");

    // Ultra plan requesting data_driven -> allowed
    const req2 = {
        workspaceId: "ws2",
        workspace: { id: "ws2", plan: "ultra" },
        query: { model: "data_driven" },
    };
    const res2 = makeRes();
    let next2 = false;
    await requireModelAllowed(req2, res2, () => { next2 = true; });
    assert.equal(next2, true);
});

test("requireFeature gates feature flags by plan", async () => {
    const csvGuard = requireFeature("csvExports");

    // Free plan has csvExports = false
    const req1 = {
        workspaceId: "ws_free",
        workspace: { id: "ws_free", plan: "free" },
    };
    const res1 = makeRes();
    let next1 = false;
    await csvGuard(req1, res1, () => { next1 = true; });
    assert.equal(next1, false);
    assert.equal(res1.statusCode, 403);

    // Pro plan has csvExports = true
    const req2 = {
        workspaceId: "ws_pro",
        workspace: { id: "ws_pro", plan: "pro" },
    };
    const res2 = makeRes();
    let next2 = false;
    await csvGuard(req2, res2, () => { next2 = true; });
    assert.equal(next2, true);
});

test("subscriptionGracePeriodSweep suspends past_due workspaces after 7 days", async () => {
    const fake = createFakeDb();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();

    fake.tables.Workspace = [
        // Expired grace period (> 7 days) -> should be suspended
        {
            id: "ws_expired",
            status: "active",
            subscriptionStatus: "past_due",
            currentPeriodEnd: tenDaysAgo,
        },
        // Still within grace period (< 7 days) -> should remain active
        {
            id: "ws_grace",
            status: "active",
            subscriptionStatus: "past_due",
            currentPeriodEnd: twoDaysAgo,
        },
    ];

    await subscriptionGracePeriodSweep(fake.db);

    const expired = fake.tables.Workspace.find((w) => w.id === "ws_expired");
    assert.equal(expired.status, "suspended");
    assert.ok(expired.suspendedReason.includes("grace period expired"));

    const withinGrace = fake.tables.Workspace.find((w) => w.id === "ws_grace");
    assert.equal(withinGrace.status, "active");
});

