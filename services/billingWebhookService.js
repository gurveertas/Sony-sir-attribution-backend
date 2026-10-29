/**
 * Service to handle incoming Stripe webhook events for platform billing.
 */

import { PLANS, PLAN_TIERS, SUBSCRIPTION_STATUSES, BILLING_INTERVALS } from "../config/plans.js";

/**
 * Maps a Stripe subscription object to our Workspace model fields.
 */
function mapStripeSubscriptionFields(subscription) {
    const statusMap = {
        active: SUBSCRIPTION_STATUSES.ACTIVE,
        trialing: SUBSCRIPTION_STATUSES.TRIALING,
        past_due: SUBSCRIPTION_STATUSES.PAST_DUE,
        canceled: SUBSCRIPTION_STATUSES.CANCELED,
        unpaid: SUBSCRIPTION_STATUSES.UNPAID,
    };

    const status = statusMap[subscription.status] || SUBSCRIPTION_STATUSES.ACTIVE;
    const currentPeriodStart = subscription.current_period_start
        ? new Date(subscription.current_period_start * 1000).toISOString()
        : null;
    const currentPeriodEnd = subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null;

    return {
        subscriptionStatus: status,
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        currentPeriodStart,
        currentPeriodEnd,
    };
}

/**
 * Finds the workspace targeted by a Stripe event via metadata, subscriptionId, or customerId.
 */
export async function findTargetWorkspace(orm, { workspaceId, subscriptionId, customerId }) {
    if (workspaceId) {
        const byId = await orm.Workspace.where({ id: workspaceId }).first();
        if (byId) return byId;
    }
    if (subscriptionId) {
        const bySub = await orm.Workspace.where({ subscriptionId }).first();
        if (bySub) return bySub;
    }
    if (customerId) {
        const byCust = await orm.Workspace.where({ billingCustomerId: customerId }).first();
        if (byCust) return byCust;
    }
    return null;
}

/**
 * Processes a verified Stripe billing webhook event.
 */
export async function processBillingWebhookEvent(orm, event) {
    const eventType = event.type;
    const dataObj = event.data?.object;

    if (!dataObj) {
        return { handled: false, reason: "No data.object in event" };
    }

    switch (eventType) {
        case "checkout.session.completed": {
            if (dataObj.mode !== "subscription") {
                return { handled: false, reason: "Checkout mode is not subscription" };
            }
            const workspaceId = dataObj.metadata?.workspaceId || dataObj.subscription_data?.metadata?.workspaceId;
            const planTier = (dataObj.metadata?.planTier || PLAN_TIERS.PRO).toLowerCase();
            const interval = (dataObj.metadata?.interval || BILLING_INTERVALS.MONTHLY).toLowerCase();
            const customerId = dataObj.customer;
            const subscriptionId = dataObj.subscription;

            const workspace = await findTargetWorkspace(orm, { workspaceId, customerId });
            if (!workspace) {
                return { handled: false, error: `Workspace not found for id ${workspaceId}` };
            }

            const planConfig = PLANS[planTier] || PLANS[PLAN_TIERS.PRO];
            await orm.Workspace.where({ id: workspace.id }).update({
                plan: planConfig.id,
                billingInterval: interval,
                subscriptionStatus: SUBSCRIPTION_STATUSES.ACTIVE,
                billingCustomerId: customerId,
                subscriptionId: subscriptionId,
                monthlyOrderLimit: planConfig.limits.monthlyOrders,
                cancelAtPeriodEnd: false,
            });

            return {
                handled: true,
                action: "checkout_completed",
                workspaceId: workspace.id,
                plan: planConfig.id,
            };
        }

        case "customer.subscription.updated": {
            const subscriptionId = dataObj.id;
            const customerId = dataObj.customer;
            const workspaceId = dataObj.metadata?.workspaceId;

            const workspace = await findTargetWorkspace(orm, { workspaceId, subscriptionId, customerId });
            if (!workspace) {
                return { handled: false, error: `Workspace not found for subscription ${subscriptionId}` };
            }

            const updates = mapStripeSubscriptionFields(dataObj);
            const planTier = dataObj.metadata?.planTier?.toLowerCase();
            if (planTier && PLANS[planTier]) {
                updates.plan = planTier;
                updates.monthlyOrderLimit = PLANS[planTier].limits.monthlyOrders;
            }

            await orm.Workspace.where({ id: workspace.id }).update(updates);
            return {
                handled: true,
                action: "subscription_updated",
                workspaceId: workspace.id,
                status: updates.subscriptionStatus,
            };
        }

        case "customer.subscription.deleted": {
            const subscriptionId = dataObj.id;
            const customerId = dataObj.customer;
            const workspaceId = dataObj.metadata?.workspaceId;

            const workspace = await findTargetWorkspace(orm, { workspaceId, subscriptionId, customerId });
            if (!workspace) {
                return { handled: false, error: `Workspace not found for subscription ${subscriptionId}` };
            }

            // Revert to free tier
            await orm.Workspace.where({ id: workspace.id }).update({
                plan: PLAN_TIERS.FREE,
                subscriptionStatus: SUBSCRIPTION_STATUSES.CANCELED,
                subscriptionId: null,
                monthlyOrderLimit: PLANS[PLAN_TIERS.FREE].limits.monthlyOrders,
                cancelAtPeriodEnd: false,
            });

            return {
                handled: true,
                action: "subscription_canceled",
                workspaceId: workspace.id,
                plan: PLAN_TIERS.FREE,
            };
        }

        case "invoice.payment_failed": {
            const customerId = dataObj.customer;
            const workspace = await findTargetWorkspace(orm, { customerId });
            if (!workspace) {
                return { handled: false, error: `Workspace not found for customer ${customerId}` };
            }

            await orm.Workspace.where({ id: workspace.id }).update({
                subscriptionStatus: SUBSCRIPTION_STATUSES.PAST_DUE,
            });

            return {
                handled: true,
                action: "payment_failed",
                workspaceId: workspace.id,
                status: SUBSCRIPTION_STATUSES.PAST_DUE,
            };
        }

        case "invoice.paid":
        case "invoice.payment_succeeded": {
            const customerId = dataObj.customer;
            const workspace = await findTargetWorkspace(orm, { customerId });
            if (!workspace) return { handled: false, reason: "Workspace not found" };

            // If this invoice represents a recurring renewal cycle, reset monthly order counter
            const isRenewal = dataObj.billing_reason === "subscription_cycle";
            const updates = {
                subscriptionStatus: SUBSCRIPTION_STATUSES.ACTIVE,
            };
            if (isRenewal) {
                updates.currentPeriodOrderCount = 0;
            }

            await orm.Workspace.where({ id: workspace.id }).update(updates);
            return {
                handled: true,
                action: "invoice_paid",
                workspaceId: workspace.id,
                counterReset: isRenewal,
            };
        }

        default:
            return { handled: false, reason: `Unhandled event type ${eventType}` };
    }
}

