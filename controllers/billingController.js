/**
 * Workspace Billing Controller — /api/workspace/billing/*
 *
 * Provides:
 *   - GET  /api/workspace/billing          Current subscription status, limits, usage & plans
 *   - POST /api/workspace/billing/checkout Create Stripe Checkout Session for Pro / Ultra
 *   - POST /api/workspace/billing/portal   Create Stripe Customer Portal session
 */

import { db } from "../src/prisma/db.js";
import { sendError } from "../services/http.js";
import { PLANS } from "../config/plans.js";
import {
    getBillingOverview,
    createCheckoutSession,
    createCustomerPortalSession,
} from "../services/billingService.js";

const orm = () => db.orm.public;

/**
 * GET /api/workspace/billing/plans or GET /api/billing/plans
 * Returns the catalog of plans (Free, Pro, Ultra) with pricing, limits, and features.
 */
export const getAvailablePlans = async (req, res) => {
    try {
        const workspaceId = req.user?.workspaceId;
        let currentPlan = null;
        if (workspaceId) {
            const workspace = await orm().Workspace.where({ id: workspaceId }).first();
            currentPlan = workspace?.plan || "free";
        }
        const plans = Object.values(PLANS).map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            pricing: p.pricing,
            limits: p.limits,
            features: p.features,
            isCurrent: currentPlan ? p.id === currentPlan : false,
        }));
        return res.status(200).json({ data: plans });
    } catch (error) {
        return sendError(res, error, "getAvailablePlans");
    }
};

/**
 * GET /api/workspace/billing
 */
export const getBillingStatus = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const workspace = await orm().Workspace.where({ id: workspaceId }).first();
        if (!workspace) return res.status(404).json({ message: "Workspace not found", code: "not_found" });

        const overview = getBillingOverview(workspace);
        return res.status(200).json({ data: overview });
    } catch (error) {
        return sendError(res, error, "getBillingStatus");
    }
};

/**
 * POST /api/workspace/billing/checkout
 * Body: { plan: "pro" | "ultra", interval?: "monthly" | "annually", successUrl?, cancelUrl? }
 */
export const startPlanCheckout = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const workspace = await orm().Workspace.where({ id: workspaceId }).first();
        if (!workspace) return res.status(404).json({ message: "Workspace not found", code: "not_found" });

        const { plan, interval = "monthly", successUrl, cancelUrl } = req.body ?? {};
        if (!plan) {
            return res.status(400).json({
                message: "plan is required (choose 'pro' or 'ultra')",
                code: "validation_error",
            });
        }

        const session = await createCheckoutSession({
            workspace,
            user: req.user,
            planTier: plan,
            interval,
            successUrl,
            cancelUrl,
        });

        return res.status(200).json({ data: session });
    } catch (error) {
        return sendError(res, error, "startPlanCheckout");
    }
};

/**
 * POST /api/workspace/billing/portal
 * Body: { returnUrl? }
 */
export const openCustomerPortal = async (req, res) => {
    try {
        const workspaceId = req.user.workspaceId;
        const workspace = await orm().Workspace.where({ id: workspaceId }).first();
        if (!workspace) return res.status(404).json({ message: "Workspace not found", code: "not_found" });

        const { returnUrl } = req.body ?? {};
        const portal = await createCustomerPortalSession({
            workspace,
            returnUrl,
        });

        return res.status(200).json({ data: portal });
    } catch (error) {
        return sendError(res, error, "openCustomerPortal");
    }
};

