import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { PLANS, PLAN_TIERS } from "../config/plans.js";
import {
    getWorkspacePlan,
    hasMinimumPlan,
    isModelAllowedForWorkspace,
    formatWorkspaceSubscription,
} from "../services/planService.js";

test("plans configuration defines Pro and Ultra with pricing and annual discount", () => {
    assert.ok(PLANS[PLAN_TIERS.PRO].pricing.monthly > 0);
    assert.ok(PLANS[PLAN_TIERS.PRO].pricing.annually > 0);
    assert.ok(PLANS[PLAN_TIERS.ULTRA].pricing.monthly > PLANS[PLAN_TIERS.PRO].pricing.monthly);
    assert.ok(PLANS[PLAN_TIERS.ULTRA].pricing.annually > PLANS[PLAN_TIERS.PRO].pricing.annually);

    assert.ok(PLANS[PLAN_TIERS.ULTRA].limits.monthlyOrders > PLANS[PLAN_TIERS.PRO].limits.monthlyOrders);
    assert.ok(PLANS[PLAN_TIERS.PRO].limits.monthlyOrders > PLANS[PLAN_TIERS.FREE].limits.monthlyOrders);
});

test("getWorkspacePlan resolves plan or defaults to Free", () => {
    assert.equal(getWorkspacePlan({ plan: "pro" }).id, "pro");
    assert.equal(getWorkspacePlan({ plan: "PRO" }).id, "pro");
    assert.equal(getWorkspacePlan({ plan: "ultra" }).id, "ultra");
    assert.equal(getWorkspacePlan({ plan: null }).id, "free");
    assert.equal(getWorkspacePlan({}).id, "free");
});

test("hasMinimumPlan validates hierarchical plan rank", () => {
    const freeWs = { plan: "free" };
    const proWs = { plan: "pro" };
    const ultraWs = { plan: "ultra" };

    // Free
    assert.equal(hasMinimumPlan(freeWs, "free"), true);
    assert.equal(hasMinimumPlan(freeWs, "pro"), false);
    assert.equal(hasMinimumPlan(freeWs, "ultra"), false);

    // Pro
    assert.equal(hasMinimumPlan(proWs, "free"), true);
    assert.equal(hasMinimumPlan(proWs, "pro"), true);
    assert.equal(hasMinimumPlan(proWs, "ultra"), false);

    // Ultra
    assert.equal(hasMinimumPlan(ultraWs, "free"), true);
    assert.equal(hasMinimumPlan(ultraWs, "pro"), true);
    assert.equal(hasMinimumPlan(ultraWs, "ultra"), true);
});

test("isModelAllowedForWorkspace gates advanced attribution models", () => {
    const freeWs = { plan: "free" };
    const proWs = { plan: "pro" };
    const ultraWs = { plan: "ultra" };

    assert.equal(isModelAllowedForWorkspace(freeWs, "linear"), true);
    assert.equal(isModelAllowedForWorkspace(freeWs, "position_based"), false);

    assert.equal(isModelAllowedForWorkspace(proWs, "position_based"), true);
    assert.equal(isModelAllowedForWorkspace(proWs, "data_driven"), false);

    assert.equal(isModelAllowedForWorkspace(ultraWs, "data_driven"), true);
});

test("formatWorkspaceSubscription calculates correct usage and format", () => {
    const ws = {
        plan: "pro",
        billingInterval: "monthly",
        subscriptionStatus: "active",
        monthlyOrderLimit: 15000,
        currentPeriodOrderCount: 7500,
        currentPeriodEnd: "2026-11-29T00:00:00Z",
    };

    const formatted = formatWorkspaceSubscription(ws);
    assert.equal(formatted.plan, "pro");
    assert.equal(formatted.planName, "Pro Plan");
    assert.equal(formatted.usage.ordersUsed, 7500);
    assert.equal(formatted.usage.orderLimit, 15000);
    assert.equal(formatted.usage.percentUsed, 50);
    assert.equal(formatted.usage.isOverLimit, false);
});

