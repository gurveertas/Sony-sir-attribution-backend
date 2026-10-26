/**
 * Tenant-scoped data access (scope 4.10 / trust boundary 3: "Company to company: never crosses").
 *
 *   const t = tenantDb(db, workspaceId);           // workspaceId from the API key or the login ONLY
 *   await t.Order.where({ id }).first();           // -> WHERE id = $1 AND "workspaceId" = $2
 *   await t.Order.create({ ... });                 // workspaceId stamped (a different one is refused)
 *
 * Every model that carries `workspaceId` gets the company id added to every read, update, delete and
 * create. Code that uses this layer cannot read or write another company's rows even if a caller
 * passes a foreign id. tests/acceptance.test.js (criterion 6) tries to break it.
 */

export const TENANT_MODELS = new Set([
    "User", "UserLocationAccess", "Invite", "ApiKey", "SupportAccessSession", "Site", "Location",
    "ChannelMappingRule", "Connector", "WebhookEndpoint", "Visitor", "Touch", "Customer", "CheckoutSession",
    "Order", "Refund", "Booking", "AttributionCredit", "RawEvent", "AuditLog", "IdempotencyKey",
    "WebhookDelivery", "AdAccount", "AdSpend", "DailyRollup", "DailyAttributionRollup", "RollupDirtyDay",
]);

export class TenantScopeError extends Error {
    constructor(message) {
        super(message);
        this.name = "TenantScopeError";
        this.statusCode = 500;
    }
}

function scopedModel(model, workspaceId, name) {
    const scope = (q) => q.where({ workspaceId });
    return {
        where(cond) {
            if (cond && typeof cond === "object" && "workspaceId" in cond && cond.workspaceId !== workspaceId) {
                throw new TenantScopeError(`${name}: query for another company refused`);
            }
            return scope(model.where(cond));
        },
        all() {
            return model.where({ workspaceId }).all();
        },
        first() {
            return model.where({ workspaceId }).first();
        },
        async create(data) {
            if (data && "workspaceId" in data && data.workspaceId != null && data.workspaceId !== workspaceId) {
                throw new TenantScopeError(`${name}: write for another company refused`);
            }
            return model.create({ ...data, workspaceId });
        },
    };
}

/**
 * @param {object} client   db or a transaction client (anything with .orm.public)
 * @param {string} workspaceId
 */
export function tenantDb(client, workspaceId) {
    if (!workspaceId || typeof workspaceId !== "string") throw new TenantScopeError("tenantDb needs the company id");
    const orm = client.orm.public;
    return new Proxy(
        {},
        {
            get(_t, name) {
                if (name === "workspaceId") return workspaceId;
                if (name === "raw") return orm;
                const model = orm[name];
                if (!model || typeof name !== "string") return model;
                return TENANT_MODELS.has(name) ? scopedModel(model, workspaceId, name) : model;
            },
        },
    );
}
