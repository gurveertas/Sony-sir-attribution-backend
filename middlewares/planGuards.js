/**
 * Plan gating middlewares for protecting premium tiers and features.
 */

import { db } from "../src/prisma/db.js";
import { PLANS, PLAN_TIERS, PLAN_RANK } from "../config/plans.js";
import { getWorkspacePlan, hasMinimumPlan, isModelAllowedForWorkspace } from "../services/planService.js";

const orm = () => db.orm.public;

/**
 * Ensures the requesting workspace meets or exceeds the required plan tier.
 * @param {("free"|"pro"|"ultra")} minimumTier
 */
export const requireMinimumPlan = (minimumTier) => async (req, res, next) => {
    try {
        const workspaceId = req.workspaceId || req.user?.workspaceId;
        if (!workspaceId) return res.status(400).json({ message: "Workspace context is required", code: "validation_error" });

        const workspace = req.workspace || await orm().Workspace.where({ id: workspaceId }).first();
        if (!workspace) return res.status(404).json({ message: "Workspace not found", code: "not_found" });

        req.workspace = workspace;

        if (!hasMinimumPlan(workspace, minimumTier)) {
            const currentPlan = workspace.plan || PLAN_TIERS.FREE;
            return res.status(403).json({
                message: `This action requires a ${minimumTier.toUpperCase()} plan or higher. Your workspace is currently on the ${currentPlan.toUpperCase()} plan.`,
                code: "upgrade_required",
                currentPlan,
                requiredPlan: minimumTier,
            });
        }

        next();
    } catch (error) {
        console.error("requireMinimumPlan guard error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * Ensures the requested attribution model (via query param ?model= or body.model)
 * is unlocked on the workspace's plan tier.
 */
export const requireModelAllowed = async (req, res, next) => {
    try {
        const requestedModel = req.query?.model || req.body?.model;
        if (!requestedModel) return next(); // default model will be resolved downstream

        const workspaceId = req.workspaceId || req.user?.workspaceId;
        if (!workspaceId) return next();

        const workspace = req.workspace || await orm().Workspace.where({ id: workspaceId }).first();
        if (!workspace) return next();

        if (!isModelAllowedForWorkspace(workspace, requestedModel)) {
            const currentPlan = workspace.plan || PLAN_TIERS.FREE;
            const requiredTier = requestedModel === "data_driven" ? PLAN_TIERS.ULTRA : PLAN_TIERS.PRO;
            return res.status(403).json({
                message: `The '${requestedModel}' attribution model is not available on the ${currentPlan.toUpperCase()} plan. Upgrade to ${requiredTier.toUpperCase()} to unlock it.`,
                code: "model_upgrade_required",
                requestedModel,
                currentPlan,
                requiredPlan: requiredTier,
            });
        }

        next();
    } catch (error) {
        console.error("requireModelAllowed guard error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * Ensures a specific feature boolean flag (e.g. csvExports, customLookback) is enabled.
 */
export const requireFeature = (featureName) => async (req, res, next) => {
    try {
        const workspaceId = req.workspaceId || req.user?.workspaceId;
        if (!workspaceId) return res.status(400).json({ message: "Workspace context is required", code: "validation_error" });

        const workspace = req.workspace || await orm().Workspace.where({ id: workspaceId }).first();
        if (!workspace) return res.status(404).json({ message: "Workspace not found", code: "not_found" });

        const plan = getWorkspacePlan(workspace);
        if (!plan.features[featureName]) {
            return res.status(403).json({
                message: `Feature '${featureName}' is not enabled on your ${plan.name}. Please upgrade to access this feature.`,
                code: "feature_upgrade_required",
                feature: featureName,
                currentPlan: plan.id,
            });
        }

        next();
    } catch (error) {
        console.error("requireFeature guard error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};
