import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
    serializeStripeParams,
    resolvePriceId,
    getBillingOverview,
    createCheckoutSession,
    createCustomerPortalSession,
} from "../services/billingService.js";
import { makeRes } from "./fakeDb.js";
import { getBillingStatus, getAvailablePlans, startPlanCheckout, openCustomerPortal } from "../controllers/billingController.js";
import ENV from "../utils/env.js";

test("serializeStripeParams correctly formats nested parameters for Stripe form encoding", () => {
    const input = {
        mode: "subscription",
        metadata: {
            workspaceId: "ws_123",
            tier: "pro",
        },
        line_items: [
            { price: "price_abc", quantity: 1 },
        ],
    };
    const serialized = serializeStripeParams(input);
    assert.ok(serialized.includes("mode=subscription"));
    assert.ok(serialized.includes("metadata%5BworkspaceId%5D=ws_123"));
    assert.ok(serialized.includes("metadata%5Btier%5D=pro"));
    assert.ok(serialized.includes("line_items%5B0%5D%5Bprice%5D=price_abc"));
    assert.ok(serialized.includes("line_items%5B0%5D%5Bquantity%5D=1"));
});

test("resolvePriceId returns configured price IDs for tier and interval", () => {
    ENV.STRIPE_PRICE_ID_PRO_MONTHLY = "price_pro_m";
    ENV.STRIPE_PRICE_ID_PRO_ANNUALLY = "price_pro_y";
    ENV.STRIPE_PRICE_ID_ULTRA_MONTHLY = "price_ultra_m";
    ENV.STRIPE_PRICE_ID_ULTRA_ANNUALLY = "price_ultra_y";

    assert.equal(resolvePriceId("pro", "monthly"), "price_pro_m");
    assert.equal(resolvePriceId("pro", "annually"), "price_pro_y");
    assert.equal(resolvePriceId("ultra", "monthly"), "price_ultra_m");
    assert.equal(resolvePriceId("ultra", "annually"), "price_ultra_y");
    assert.equal(resolvePriceId("free", "monthly"), null);
});

test("getBillingOverview aggregates current workspace status and plan catalog", () => {
    const ws = {
        id: "ws1",
        plan: "pro",
        billingInterval: "monthly",
        subscriptionStatus: "active",
        monthlyOrderLimit: 15000,
        currentPeriodOrderCount: 3000,
    };
    const overview = getBillingOverview(ws);
    assert.equal(overview.current.plan, "pro");
    assert.equal(overview.current.usage.ordersUsed, 3000);
    assert.equal(overview.plans.length, 3); // free, pro, ultra
    const proPlan = overview.plans.find((p) => p.id === "pro");
    assert.equal(proPlan.isCurrent, true);
    assert.equal(proPlan.pricing.monthly, 2000);
});

test("createCheckoutSession validates plan tier and creates checkout session", async () => {
    const ws = { id: "ws_test", billingCustomerId: null };
    const user = { id: "u_1", email: "owner@brand.com" };

    // Invalid tier should fail with 400
    await assert.rejects(
        createCheckoutSession({ workspace: ws, user, planTier: "gold" }),
        (err) => err.statusCode === 400
    );

    // Mock mode when STRIPE_SECRET_KEY is null
    const origKey = ENV.STRIPE_SECRET_KEY;
    ENV.STRIPE_SECRET_KEY = null;
    const mockSession = await createCheckoutSession({
        workspace: ws,
        user,
        planTier: "pro",
        interval: "monthly",
    });
    assert.equal(mockSession.mock, true);
    assert.ok(mockSession.checkoutUrl.includes("settings/billing"));

    // Live mode simulation with fetchImpl
    ENV.STRIPE_SECRET_KEY = "sk_test_fake_123";
    let requestMade = null;
    const fakeFetch = async (url, options) => {
        requestMade = { url, options };
        return {
            ok: true,
            status: 200,
            json: async () => ({ id: "cs_stripe_real_123", url: "https://checkout.stripe.com/pay/cs_stripe_real_123" }),
        };
    };

    const session = await createCheckoutSession({
        workspace: ws,
        user,
        planTier: "ultra",
        interval: "annually",
        fetchImpl: fakeFetch,
    });
    assert.equal(session.sessionId, "cs_stripe_real_123");
    assert.equal(session.checkoutUrl, "https://checkout.stripe.com/pay/cs_stripe_real_123");
    assert.ok(requestMade.options.body.includes("metadata%5BplanTier%5D=ultra"));
    assert.ok(requestMade.options.body.includes("metadata%5Binterval%5D=annually"));

    ENV.STRIPE_SECRET_KEY = origKey;
});

test("createCustomerPortalSession requires billing customer and generates portal url", async () => {
    const wsWithoutCust = { id: "ws1", billingCustomerId: null };
    await assert.rejects(
        createCustomerPortalSession({ workspace: wsWithoutCust }),
        (err) => err.statusCode === 400
    );

    const wsWithCust = { id: "ws1", billingCustomerId: "cus_123" };
    const origKey = ENV.STRIPE_SECRET_KEY;
    ENV.STRIPE_SECRET_KEY = "sk_test_fake_123";

    const fakeFetch = async (url, options) => ({
        ok: true,
        status: 200,
        json: async () => ({ url: "https://billing.stripe.com/session_portal_123" }),
    });

    const portal = await createCustomerPortalSession({
        workspace: wsWithCust,
        fetchImpl: fakeFetch,
    });
    assert.equal(portal.portalUrl, "https://billing.stripe.com/session_portal_123");

    ENV.STRIPE_SECRET_KEY = origKey;
});

test("getAvailablePlans returns catalog of free, pro, and ultra plans", async () => {
    const req = { user: null };
    const res = makeRes();

    await getAvailablePlans(req, res);

    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.equal(res.body.data.length, 3);
    const tiers = res.body.data.map((p) => p.id);
    assert.ok(tiers.includes("free"));
    assert.ok(tiers.includes("pro"));
    assert.ok(tiers.includes("ultra"));
});

