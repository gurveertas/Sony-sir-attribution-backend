/**
 * Platform Billing Service (Stripe integration for Pro and Ultra subscriptions).
 *
 * Handles:
 *   - Stripe Checkout Session creation (upgrades/subscriptions)
 *   - Stripe Customer Portal session generation (billing management & cancellation)
 *   - Workspace subscription and usage aggregation
 */

import ENV from "../utils/env.js";
import { PLANS, PLAN_TIERS, BILLING_INTERVALS } from "../config/plans.js";
import { formatWorkspaceSubscription } from "./planService.js";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

/**
 * Maps plan tier and interval to configured Stripe Price IDs.
 */
export function resolvePriceId(planTier, interval = "monthly") {
    const tier = String(planTier).toLowerCase();
    const intv = String(interval).toLowerCase();

    if (tier === PLAN_TIERS.PRO) {
        return intv === BILLING_INTERVALS.ANNUALLY
            ? ENV.STRIPE_PRICE_ID_PRO_ANNUALLY
            : ENV.STRIPE_PRICE_ID_PRO_MONTHLY;
    }
    if (tier === PLAN_TIERS.ULTRA) {
        return intv === BILLING_INTERVALS.ANNUALLY
            ? ENV.STRIPE_PRICE_ID_ULTRA_ANNUALLY
            : ENV.STRIPE_PRICE_ID_ULTRA_MONTHLY;
    }
    return null;
}

/**
 * Serializes nested objects into application/x-www-form-urlencoded format for Stripe's API.
 */
export function serializeStripeParams(obj, prefix = "") {
    const pairs = [];
    for (const [key, val] of Object.entries(obj)) {
        if (val === undefined || val === null) continue;
        const fullKey = prefix ? `${prefix}[${key}]` : key;
        if (typeof val === "object" && !Array.isArray(val)) {
            pairs.push(serializeStripeParams(val, fullKey));
        } else if (Array.isArray(val)) {
            val.forEach((item, index) => {
                pairs.push(serializeStripeParams(item, `${fullKey}[${index}]`));
            });
        } else {
            pairs.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(val))}`);
        }
    }
    return pairs.filter(Boolean).join("&");
}

/**
 * Creates a Stripe Checkout Session for upgrading to a paid plan.
 */
export async function createCheckoutSession({
    workspace,
    user,
    planTier,
    interval = BILLING_INTERVALS.MONTHLY,
    successUrl,
    cancelUrl,
    fetchImpl = globalThis.fetch,
}) {
    const tier = String(planTier).toLowerCase();
    const validInterval = interval === BILLING_INTERVALS.ANNUALLY ? BILLING_INTERVALS.ANNUALLY : BILLING_INTERVALS.MONTHLY;

    if (![PLAN_TIERS.PRO, PLAN_TIERS.ULTRA].includes(tier)) {
        const error = new Error(`Invalid plan tier: "${planTier}". Available paid tiers are "pro" and "ultra".`);
        error.statusCode = 400;
        throw error;
    }

    const plan = PLANS[tier];
    const priceId = resolvePriceId(tier, validInterval);

    // If Stripe secret key is not set (e.g. local development / tests without Stripe keys)
    if (!ENV.STRIPE_SECRET_KEY) {
        return {
            mock: true,
            sessionId: `mock_cs_${workspace.id}_${tier}_${validInterval}`,
            checkoutUrl: `${successUrl || `${ENV.FRONTEND_URL}/settings/billing`}?mock_session_id=mock_cs_${workspace.id}`,
            plan: tier,
            interval: validInterval,
            amount: plan.pricing[validInterval],
        };
    }

    const params = {
        mode: "subscription",
        success_url: successUrl || `${ENV.FRONTEND_URL}/settings/billing?session_id={CHECKOUT_SESSION_ID}&success=true`,
        cancel_url: cancelUrl || `${ENV.FRONTEND_URL}/settings/billing?canceled=true`,
        metadata: {
            workspaceId: workspace.id,
            planTier: tier,
            interval: validInterval,
            userId: user.id,
        },
        subscription_data: {
            metadata: {
                workspaceId: workspace.id,
                planTier: tier,
                interval: validInterval,
            },
        },
    };

    if (workspace.billingCustomerId) {
        params.customer = workspace.billingCustomerId;
    } else if (user?.email) {
        params.customer_email = user.email;
    }

    if (priceId) {
        params.line_items = [{ price: priceId, quantity: 1 }];
    } else {
        // Fallback to inline price_data when Stripe dashboard price IDs are not yet registered in .env
        const amountCents = plan.pricing[validInterval] * 100;
        params.line_items = [
            {
                price_data: {
                    currency: (plan.pricing.currency || "USD").toLowerCase(),
                    product_data: {
                        name: `${plan.name} (${validInterval})`,
                        description: plan.description,
                    },
                    unit_amount: amountCents,
                    recurring: {
                        interval: validInterval === BILLING_INTERVALS.ANNUALLY ? "year" : "month",
                    },
                },
                quantity: 1,
            },
        ];
    }

    const response = await fetchImpl(`${STRIPE_API_BASE}/checkout/sessions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${ENV.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: serializeStripeParams(params),
    });

    const body = await response.json();
    if (!response.ok) {
        const error = new Error(body?.error?.message || "Failed to create Stripe Checkout Session");
        error.statusCode = response.status;
        throw error;
    }

    return {
        sessionId: body.id,
        checkoutUrl: body.url,
        plan: tier,
        interval: validInterval,
    };
}

/**
 * Creates a Stripe Customer Portal session so clients can manage their payment methods and subscriptions.
 */
export async function createCustomerPortalSession({
    workspace,
    returnUrl,
    fetchImpl = globalThis.fetch,
}) {
    if (!workspace.billingCustomerId) {
        const error = new Error("No billing customer profile found for this workspace. Please subscribe to a plan first.");
        error.statusCode = 400;
        throw error;
    }

    if (!ENV.STRIPE_SECRET_KEY) {
        return {
            mock: true,
            portalUrl: returnUrl || `${ENV.FRONTEND_URL}/settings/billing`,
        };
    }

    const params = {
        customer: workspace.billingCustomerId,
        return_url: returnUrl || `${ENV.FRONTEND_URL}/settings/billing`,
    };

    const response = await fetchImpl(`${STRIPE_API_BASE}/billing_portal/sessions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${ENV.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: serializeStripeParams(params),
    });

    const body = await response.json();
    if (!response.ok) {
        const error = new Error(body?.error?.message || "Failed to create Customer Portal session");
        error.statusCode = response.status;
        throw error;
    }

    return {
        portalUrl: body.url,
    };
}

/**
 * Returns complete subscription summary and available plans for the frontend.
 */
export function getBillingOverview(workspace) {
    const current = formatWorkspaceSubscription(workspace);
    const availablePlans = Object.values(PLANS).map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        pricing: p.pricing,
        limits: p.limits,
        features: p.features,
        isCurrent: p.id === current.plan,
    }));

    return {
        current,
        plans: availablePlans,
    };
}

