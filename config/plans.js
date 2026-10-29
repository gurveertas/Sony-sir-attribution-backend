/**
 * Plan tiers and pricing configurations for the attribution service.
 *
 * Tiers:
 *   - free: Default trial tier for new companies
 *   - pro: 2,000 / month (or 20,000 / year — 2 months free)
 *   - ultra: 4,000 / month (or 40,000 / year — 2 months free)
 */

export const PLAN_TIERS = {
    FREE: "free",
    PRO: "pro",
    ULTRA: "ultra",
};

export const BILLING_INTERVALS = {
    MONTHLY: "monthly",
    ANNUALLY: "annually",
};

export const SUBSCRIPTION_STATUSES = {
    TRIALING: "trialing",
    ACTIVE: "active",
    PAST_DUE: "past_due",
    CANCELED: "canceled",
    UNPAID: "unpaid",
};

export const PLANS = {
    [PLAN_TIERS.FREE]: {
        id: PLAN_TIERS.FREE,
        name: "Free Trial",
        description: "Explore the core features of the attribution platform",
        pricing: {
            monthly: 0,
            annually: 0,
            currency: "USD",
        },
        limits: {
            monthlyOrders: 1000,
            adAccounts: 1,
            teamMembers: 2,
            retentionMonths: 3,
            customChannelRules: 3,
            locations: 1,
        },
        features: {
            models: ["first_touch", "last_touch", "last_non_direct", "linear"],
            csvExports: false,
            apiAccess: false,
            prioritySupport: false,
            customLookback: false,
        },
    },
    [PLAN_TIERS.PRO]: {
        id: PLAN_TIERS.PRO,
        name: "Pro Plan",
        description: "For growing businesses scaling their multi-channel marketing",
        pricing: {
            monthly: 10,
            annually: 100, // $1,666 / mo (2 months free, save ~17%)
            currency: "USD",
        },
        limits: {
            monthlyOrders: 15000,
            adAccounts: 5,
            teamMembers: 5,
            retentionMonths: 13,
            customChannelRules: 20,
            locations: 5,
        },
        features: {
            models: ["first_touch", "last_touch", "last_non_direct", "linear", "position_based", "time_decay"],
            csvExports: true,
            apiAccess: true,
            prioritySupport: false,
            customLookback: true,
        },
    },
    [PLAN_TIERS.ULTRA]: {
        id: PLAN_TIERS.ULTRA,
        name: "Ultra Plan",
        description: "For high-volume brands needing advanced attribution and dedicated support",
        pricing: {
            monthly: 20,
            annually: 210, // $3,333 / mo (2 months free, save ~17%)
            currency: "USD",
        },
        limits: {
            monthlyOrders: 100000,
            adAccounts: 50,
            teamMembers: 50,
            retentionMonths: 36,
            customChannelRules: 100,
            locations: 50,
        },
        features: {
            models: ["first_touch", "last_touch", "last_non_direct", "linear", "position_based", "time_decay", "data_driven"],
            csvExports: true,
            apiAccess: true,
            prioritySupport: true,
            customLookback: true,
        },
    },
};

/** Plan hierarchy for permission escalation checks (higher number = more privileges). */
export const PLAN_RANK = {
    [PLAN_TIERS.FREE]: 0,
    [PLAN_TIERS.PRO]: 1,
    [PLAN_TIERS.ULTRA]: 2,
};

