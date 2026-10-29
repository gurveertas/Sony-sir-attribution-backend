import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "./fakeDb.js";
import { processBillingWebhookEvent } from "../services/billingWebhookService.js";
import { PLAN_TIERS, SUBSCRIPTION_STATUSES } from "../config/plans.js";

test("checkout.session.completed activates subscription and sets Pro tier", async () => {
    const fake = createFakeDb();
    fake.tables.Workspace = [
        {
            id: "ws_sub_1",
            plan: "free",
            subscriptionStatus: "active",
            billingCustomerId: null,
            subscriptionId: null,
            monthlyOrderLimit: 1000,
        },
    ];

    const event = {
        type: "checkout.session.completed",
        data: {
            object: {
                mode: "subscription",
                customer: "cus_stripe_123",
                subscription: "sub_stripe_abc",
                metadata: {
                    workspaceId: "ws_sub_1",
                    planTier: "pro",
                    interval: "monthly",
                },
            },
        },
    };

    const result = await processBillingWebhookEvent(fake.db.orm.public, event);
    assert.equal(result.handled, true);
    assert.equal(result.action, "checkout_completed");

    const updated = fake.tables.Workspace.find((w) => w.id === "ws_sub_1");
    assert.equal(updated.plan, "pro");
    assert.equal(updated.billingInterval, "monthly");
    assert.equal(updated.subscriptionStatus, "active");
    assert.equal(updated.billingCustomerId, "cus_stripe_123");
    assert.equal(updated.subscriptionId, "sub_stripe_abc");
    assert.equal(updated.monthlyOrderLimit, 15000);
});

test("customer.subscription.updated updates period dates and cancel status", async () => {
    const fake = createFakeDb();
    fake.tables.Workspace = [
        {
            id: "ws_sub_2",
            plan: "pro",
            subscriptionId: "sub_stripe_existing",
            billingCustomerId: "cus_stripe_456",
            subscriptionStatus: "active",
            cancelAtPeriodEnd: false,
        },
    ];

    const event = {
        type: "customer.subscription.updated",
        data: {
            object: {
                id: "sub_stripe_existing",
                customer: "cus_stripe_456",
                status: "active",
                cancel_at_period_end: true,
                current_period_start: 1730000000,
                current_period_end: 1732600000,
                metadata: {
                    workspaceId: "ws_sub_2",
                    planTier: "ultra",
                },
            },
        },
    };

    const result = await processBillingWebhookEvent(fake.db.orm.public, event);
    assert.equal(result.handled, true);
    assert.equal(result.action, "subscription_updated");

    const updated = fake.tables.Workspace.find((w) => w.id === "ws_sub_2");
    assert.equal(updated.plan, "ultra");
    assert.equal(updated.cancelAtPeriodEnd, true);
    assert.ok(updated.currentPeriodStart !== null);
    assert.ok(updated.currentPeriodEnd !== null);
    assert.equal(updated.monthlyOrderLimit, 100000);
});

test("customer.subscription.deleted downgrades workspace to free tier", async () => {
    const fake = createFakeDb();
    fake.tables.Workspace = [
        {
            id: "ws_sub_3",
            plan: "ultra",
            subscriptionId: "sub_to_cancel",
            billingCustomerId: "cus_cancel",
            subscriptionStatus: "active",
            monthlyOrderLimit: 100000,
        },
    ];

    const event = {
        type: "customer.subscription.deleted",
        data: {
            object: {
                id: "sub_to_cancel",
                customer: "cus_cancel",
            },
        },
    };

    const result = await processBillingWebhookEvent(fake.db.orm.public, event);
    assert.equal(result.handled, true);
    assert.equal(result.action, "subscription_canceled");

    const updated = fake.tables.Workspace.find((w) => w.id === "ws_sub_3");
    assert.equal(updated.plan, PLAN_TIERS.FREE);
    assert.equal(updated.subscriptionStatus, SUBSCRIPTION_STATUSES.CANCELED);
    assert.equal(updated.subscriptionId, null);
    assert.equal(updated.monthlyOrderLimit, 1000);
});

test("invoice.payment_failed marks workspace past_due", async () => {
    const fake = createFakeDb();
    fake.tables.Workspace = [
        {
            id: "ws_sub_4",
            plan: "pro",
            billingCustomerId: "cus_failed_card",
            subscriptionStatus: "active",
        },
    ];

    const event = {
        type: "invoice.payment_failed",
        data: {
            object: {
                customer: "cus_failed_card",
            },
        },
    };

    const result = await processBillingWebhookEvent(fake.db.orm.public, event);
    assert.equal(result.handled, true);
    assert.equal(result.action, "payment_failed");

    const updated = fake.tables.Workspace.find((w) => w.id === "ws_sub_4");
    assert.equal(updated.subscriptionStatus, SUBSCRIPTION_STATUSES.PAST_DUE);
});

test("invoice.paid resets currentPeriodOrderCount on subscription_cycle", async () => {
    const fake = createFakeDb();
    fake.tables.Workspace = [
        {
            id: "ws_sub_5",
            billingCustomerId: "cus_renewal",
            subscriptionStatus: "past_due",
            currentPeriodOrderCount: 9400,
        },
    ];

    const event = {
        type: "invoice.paid",
        data: {
            object: {
                customer: "cus_renewal",
                billing_reason: "subscription_cycle",
            },
        },
    };

    const result = await processBillingWebhookEvent(fake.db.orm.public, event);
    assert.equal(result.handled, true);
    assert.equal(result.counterReset, true);

    const updated = fake.tables.Workspace.find((w) => w.id === "ws_sub_5");
    assert.equal(updated.subscriptionStatus, SUBSCRIPTION_STATUSES.ACTIVE);
    assert.equal(updated.currentPeriodOrderCount, 0);
});

