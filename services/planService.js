import { PLANS, PLAN_TIERS, PLAN_RANK, SUBSCRIPTION_STATUSES } from "../config/plans.js";

/**
 * Resolves the plan configuration for a workspace, defaulting to Free tier.
 */
export function getWorkspacePlan(workspace) {
    const tier = workspace?.plan?.toLowerCase() || PLAN_TIERS.FREE;
    return PLANS[tier] || PLANS[PLAN_TIERS.FREE];
}

/**
 * Checks if a workspace meets or exceeds the minimum required plan tier.
 */
export function hasMinimumPlan(workspace, minimumTier) {
    const currentTier = workspace?.plan?.toLowerCase() || PLAN_TIERS.FREE;
    const currentRank = PLAN_RANK[currentTier] ?? 0;
    const requiredRank = PLAN_RANK[minimumTier] ?? 0;
    return currentRank >= requiredRank;
}

/**
 * Checks whether an attribution model is unlocked for the workspace's plan.
 */
export function isModelAllowedForWorkspace(workspace, model) {
    const plan = getWorkspacePlan(workspace);
    return plan.features.models.includes(model);
}

/**
 * Returns clean subscription details and usage summary for API consumers.
 */
export function formatWorkspaceSubscription(workspace) {
    const plan = getWorkspacePlan(workspace);
    const orderLimit = workspace.monthlyOrderLimit ?? plan.limits.monthlyOrders;
    const ordersUsed = workspace.currentPeriodOrderCount ?? 0;
    const percentUsed = orderLimit > 0 ? Math.min(100, Math.round((ordersUsed / orderLimit) * 100)) : 0;

    return {
        plan: plan.id,
        planName: plan.name,
        billingInterval: workspace.billingInterval || "monthly",
        status: workspace.subscriptionStatus || SUBSCRIPTION_STATUSES.ACTIVE,
        currentPeriodStart: workspace.currentPeriodStart ?? null,
        currentPeriodEnd: workspace.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: Boolean(workspace.cancelAtPeriodEnd),
        trialEndsAt: workspace.trialEndsAt ?? null,
        limits: plan.limits,
        features: plan.features,
        usage: {
            ordersUsed,
            orderLimit,
            percentUsed,
            isOverLimit: ordersUsed >= orderLimit,
        },
    };
}

