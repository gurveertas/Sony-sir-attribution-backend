# Paid Subscription Plans & Billing — Frontend API Guide

This document covers all the endpoints, payloads, response shapes, and error codes needed to integrate the paid billing system into the frontend dashboard.

---

## 1. Plan Matrix Reference

| Feature / Limit | Free | Pro ($2,000/mo or $20,000/yr) | Ultra ($4,000/mo or $40,000/yr) |
| :--- | :--- | :--- | :--- |
| **Monthly Orders** | 1,000 | 15,000 | 100,000 |
| **Ad Accounts** | 1 | 5 | 50 |
| **Team Members** | 2 | 5 | 50 |
| **Locations** | 1 | 5 | 50 |
| **Custom Channel Rules**| 3 | 20 | 100 |
| **Data Retention** | 3 months | 13 months | 36 months |
| **Attribution Models** | First Touch, Last Touch, Last Non-Direct, Linear | + Position-Based, Time Decay | + Data-Driven (Algorithmic) |
| **CSV Exports** | ❌ No | ✅ Yes | ✅ Yes |
| **API Access** | ❌ No | ✅ Yes | ✅ Yes |
| **Priority Support** | ❌ No | ❌ No | ✅ Yes |
| **Custom Lookback** | ❌ No | ✅ Yes | ✅ Yes |

> **Annual Discount:** Buying annually gives ~17% discount (2 months free):
> - Pro: $2,000/mo ($24,000/yr) → **$20,000/yr**
> - Ultra: $4,000/mo ($48,000/yr) → **$40,000/yr**

---

## 2. Session Auth (Workspace Subscription Details)

### `GET /api/auth/me`
Called on app initialization to read the user session and workspace status.

#### Response `200 OK`
```json
{
  "message": "Token decoded",
  "decoded": {
    "userId": "usr_abc123",
    "role": "company_admin"
  },
  "workspace": {
    "id": "ws_123",
    "name": "Acme Marketing",
    "status": "active",
    "plan": "pro",
    "subscriptionStatus": "active",
    "billingInterval": "monthly",
    "trialEndsAt": null,
    "currentPeriodEndsAt": "2026-11-29T10:00:00.000Z",
    "cancelAtPeriodEnd": false,
    "timezone": "UTC",
    "reportingCurrency": "USD",
    "defaultModel": "linear",
    "weekStart": "monday"
  }
}
```

#### Fields of Interest for Frontend:
- `workspace.plan`: `"free"` | `"pro"` | `"ultra"` (Use for plan badges, showing/hiding gated UI)
- `workspace.subscriptionStatus`: `"trialing"` | `"active"` | `"past_due"` | `"canceled"` | `"unpaid"`
- `workspace.billingInterval`: `"monthly"` | `"annually"` | `null`
- `workspace.currentPeriodEndsAt`: ISO timestamp of next renewal date
- `workspace.cancelAtPeriodEnd`: `true` if scheduled to downgrade/cancel at end of billing cycle

---

## 3. Dedicated Billing Endpoints

Mounted under `/api/workspace/billing/*` (authenticated) and `/api/billing/*` (public).

### A. Get Available Plans Catalog
Use this to fetch the list of available subscription tiers, pricing, limits, and features (e.g. for a pricing page or upgrade modal).

- **Endpoints**:
  - `GET /api/workspace/billing/plans` (Authenticated: returns `isCurrent: true` for the active workspace's tier)
  - `GET /api/billing/plans` (Public: accessible without login)
- **Allowed Roles**: Any authenticated user (or public for `/api/billing/plans`)

#### Response `200 OK`
```json
{
  "data": [
    {
      "id": "free",
      "name": "Free",
      "description": "Essential multi-touch attribution for early-stage and growing stores.",
      "pricing": {
        "monthly": { "amount": 0, "currency": "USD", "formatted": "$0" },
        "annually": { "amount": 0, "currency": "USD", "formatted": "$0", "discountPercent": 0 }
      },
      "limits": {
        "monthlyOrders": 1000,
        "adAccounts": 1,
        "teamMembers": 2,
        "retentionMonths": 3,
        "customChannelRules": 3,
        "locations": 1
      },
      "features": {
        "models": ["first_touch", "last_touch", "last_non_direct", "linear"],
        "csvExports": false,
        "apiAccess": false,
        "prioritySupport": false,
        "customLookback": false
      },
      "isCurrent": true
    },
    {
      "id": "pro",
      "name": "Pro",
      "description": "Advanced attribution models, automated ad spend import, and higher volume.",
      "pricing": {
        "monthly": { "amount": 2000, "currency": "USD", "formatted": "$2,000/mo" },
        "annually": { "amount": 20000, "currency": "USD", "formatted": "$20,000/yr", "discountPercent": 17 }
      },
      "limits": {
        "monthlyOrders": 15000,
        "adAccounts": 5,
        "teamMembers": 5,
        "retentionMonths": 13,
        "customChannelRules": 20,
        "locations": 5
      },
      "features": {
        "models": ["first_touch", "last_touch", "last_non_direct", "linear", "position_based", "time_decay"],
        "csvExports": true,
        "apiAccess": true,
        "prioritySupport": false,
        "customLookback": true
      },
      "isCurrent": false
    },
    {
      "id": "ultra",
      "name": "Ultra",
      "description": "Data-driven algorithmic attribution, massive order volumes, multi-location, and priority support.",
      "pricing": {
        "monthly": { "amount": 4000, "currency": "USD", "formatted": "$4,000/mo" },
        "annually": { "amount": 40000, "currency": "USD", "formatted": "$40,000/yr", "discountPercent": 17 }
      },
      "limits": {
        "monthlyOrders": 100000,
        "adAccounts": 50,
        "teamMembers": 50,
        "retentionMonths": 36,
        "customChannelRules": 100,
        "locations": 50
      },
      "features": {
        "models": ["first_touch", "last_touch", "last_non_direct", "linear", "position_based", "time_decay", "data_driven"],
        "csvExports": true,
        "apiAccess": true,
        "prioritySupport": true,
        "customLookback": true
      },
      "isCurrent": false
    }
  ]
}
```

---

### B. Get Full Billing Overview (Subscription + Usage + Plans)
Use this to populate the **Billing & Subscription** settings page, plan cards, usage bar, and invoice management link.

- **Endpoint**: `GET /api/workspace/billing`
- **Allowed Roles**: `company_admin`, `company_viewer`

#### Response `200 OK`
```json
{
  "subscription": {
    "plan": "free",
    "planName": "Free",
    "billingInterval": null,
    "status": "active",
    "trialEndsAt": null,
    "currentPeriodEndsAt": null,
    "cancelAtPeriodEnd": false,
    "limits": {
      "monthlyOrders": 1000,
      "adAccounts": 1,
      "teamMembers": 2,
      "retentionMonths": 3,
      "customChannelRules": 3,
      "locations": 1
    },
    "features": {
      "models": ["first_touch", "last_touch", "last_non_direct", "linear"],
      "csvExports": false,
      "apiAccess": false,
      "prioritySupport": false,
      "customLookback": false
    },
    "usage": {
      "ordersUsed": 340,
      "orderLimit": 1000,
      "percentUsed": 34,
      "isOverLimit": false
    }
  },
  "plans": [
    {
      "tier": "free",
      "name": "Free",
      "pricing": {
        "monthly": { "amount": 0, "currency": "USD", "formatted": "$0" },
        "annually": { "amount": 0, "currency": "USD", "formatted": "$0", "discountPercent": 0 }
      },
      "limits": {
        "monthlyOrders": 1000,
        "adAccounts": 1,
        "teamMembers": 2,
        "retentionMonths": 3,
        "customChannelRules": 3,
        "locations": 1
      },
      "features": {
        "models": ["first_touch", "last_touch", "last_non_direct", "linear"],
        "csvExports": false,
        "apiAccess": false,
        "prioritySupport": false,
        "customLookback": false
      }
    },
    {
      "tier": "pro",
      "name": "Pro",
      "pricing": {
        "monthly": { "amount": 2000, "currency": "USD", "formatted": "$2,000/mo" },
        "annually": { "amount": 20000, "currency": "USD", "formatted": "$20,000/yr", "discountPercent": 17 }
      },
      "limits": {
        "monthlyOrders": 15000,
        "adAccounts": 5,
        "teamMembers": 5,
        "retentionMonths": 13,
        "customChannelRules": 20,
        "locations": 5
      },
      "features": {
        "models": ["first_touch", "last_touch", "last_non_direct", "linear", "position_based", "time_decay"],
        "csvExports": true,
        "apiAccess": true,
        "prioritySupport": false,
        "customLookback": true
      }
    },
    {
      "tier": "ultra",
      "name": "Ultra",
      "pricing": {
        "monthly": { "amount": 4000, "currency": "USD", "formatted": "$4,000/mo" },
        "annually": { "amount": 40000, "currency": "USD", "formatted": "$40,000/yr", "discountPercent": 17 }
      },
      "limits": {
        "monthlyOrders": 100000,
        "adAccounts": 50,
        "teamMembers": 50,
        "retentionMonths": 36,
        "customChannelRules": 100,
        "locations": 50
      },
      "features": {
        "models": ["first_touch", "last_touch", "last_non_direct", "linear", "position_based", "time_decay", "data_driven"],
        "csvExports": true,
        "apiAccess": true,
        "prioritySupport": true,
        "customLookback": true
      }
    }
  ],
  "hasPaymentMethod": false
}
```

---

### B. Create Checkout Session (Upgrade Flow)
Called when a user clicks "Upgrade to Pro" or "Upgrade to Ultra". Creates a secure Stripe Checkout session and returns the checkout URL.

- **Endpoint**: `POST /api/workspace/billing/checkout`
- **Allowed Roles**: `company_admin`

#### Request Body
```json
{
  "tier": "pro",
  "interval": "monthly"
}
```
*Parameters:*
- `tier` (required): `"pro"` | `"ultra"` (Free tier cannot be checked out)
- `interval` (optional, default `"monthly"`): `"monthly"` | `"annually"`

#### Response `200 OK`
```json
{
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_live_...",
  "sessionId": "cs_live_..."
}
```

#### Frontend Handling:
```javascript
async function handleUpgrade(tier, interval) {
  const res = await api.post('/api/workspace/billing/checkout', { tier, interval });
  // Redirect user to Stripe hosted checkout page
  window.location.href = res.data.checkoutUrl;
}
```

### D. Return from Stripe & How Frontend Knows the Plan Changed
When payment succeeds on Stripe, Stripe automatically redirects the customer back to your frontend:
```
https://<frontend-url>/settings/billing?session_id={CHECKOUT_SESSION_ID}&success=true
```

To know which plan was bought and update the UI, the frontend simply does this on page load when `session_id` is present in the URL:

```javascript
// On the /settings/billing or /billing page load:
const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session_id');
const isSuccess = urlParams.get('success');

if (sessionId && isSuccess) {
  // 1. Pass the session_id to get the fresh billing overview
  const res = await api.get(`/api/workspace/billing?session_id=${sessionId}`);
  const { current, plans } = res.data.data;
  
  console.log("Current Plan:", current.plan);         // "pro" or "ultra"
  console.log("Plan Name:", current.planName);        // "Pro Plan" or "Ultra Plan"
  console.log("Billing Interval:", current.billingInterval); // "monthly" or "annually"
  console.log("Order Limit:", current.limits.monthlyOrders);

  // 2. Also refresh the global auth state so navbars and badges update:
  const authRes = await api.get('/api/auth/me');
  setWorkspace(authRes.data.workspace);

  // 3. Show celebration toast/banner to user:
  toast.success(`You have successfully upgraded to ${current.planName}!`);
}
```

> **Instant Sync Guarantee:** Even if the background webhook takes a moment over the internet, passing `?session_id=` to `GET /api/workspace/billing?session_id={sessionId}` causes the backend to immediately verify with Stripe on the spot and upgrade the workspace in the database synchronously. The frontend will never be left waiting!

---

### E. Open Stripe Customer Portal
Called when an existing paying customer clicks "Manage Subscription", "Update Payment Method", or "View Billing Invoices".

- **Endpoint**: `POST /api/workspace/billing/portal`
- **Allowed Roles**: `company_admin`

#### Request Body
Empty (`{}`)

#### Response `200 OK`
```json
{
  "portalUrl": "https://billing.stripe.com/p/session/..."
}
```

#### Frontend Handling:
```javascript
async function openBillingPortal() {
  const res = await api.post('/api/workspace/billing/portal');
  window.location.href = res.data.portalUrl;
}
```
*Note:* After managing cards or viewing invoices, Stripe redirects back to `/billing`.

---

## 4. Error Codes & Upgrade Modals Handling

When a user on a lower plan attempts an action that exceeds their limit or requests a gated feature, the backend returns `403 Forbidden` with a standardized machine-readable `code`.

The frontend should catch these `403` responses in an Axios/Fetch interceptor or component handler to display an **Upgrade Modal**.

### 1. `plan_limit_reached`
Returned when a quota is reached (team seats, locations, rules, ad accounts).

**Triggering Endpoints:**
- `POST /api/workspace/invites` (Seat cap)
- `POST /api/workspace/locations` (Location cap)
- `POST /api/workspace/channel-rules` (Rule cap)
- `POST /api/workspace/ad-accounts/oauth/:platform/start` (Ad account cap)

**Error Payload:**
```json
{
  "message": "Your current plan (Free) allows up to 2 team members. Please upgrade your plan to invite more users.",
  "code": "plan_limit_reached",
  "limit": "teamMembers",
  "current": 2,
  "max": 2
}
```

---

### 2. `model_upgrade_required`
Returned when a user requests an attribution model not permitted on their current plan.

**Triggering Endpoints:**
- `GET /api/workspace/reports/*?model=data_driven`
- `GET /api/workspace/orders/:id/attribution?model=data_driven`
- `GET /api/workspace/dashboard?model=position_based` (on Free plan)

**Error Payload:**
```json
{
  "message": "Attribution model \"data_driven\" is not available on your current plan (Free). Please upgrade to access this model.",
  "code": "model_upgrade_required",
  "model": "data_driven",
  "currentPlan": "Free"
}
```

---

### 3. `feature_upgrade_required`
Returned when attempting to access a premium feature flag.

**Triggering Endpoints:**
- `GET /api/workspace/data/export` (CSV Exports)
- `GET /api/workspace/customers/:id/export` (CSV Exports)

**Error Payload:**
```json
{
  "message": "Feature \"csvExports\" is not included in your current plan (Free). Please upgrade to unlock it.",
  "code": "feature_upgrade_required",
  "feature": "csvExports",
  "currentPlan": "Free"
}
```

---

### 4. `upgrade_required`
Returned on endpoints strictly requiring at least Pro or Ultra tier.

**Triggering Endpoints:**
- `POST /api/workspace/ad-spend/upload` (Requires Pro)

**Error Payload:**
```json
{
  "message": "This feature requires at least the pro plan. Your current plan is free.",
  "code": "upgrade_required",
  "requiredTier": "pro",
  "currentTier": "free"
}
```

---

## 5. Frontend Implementation Checklist

- [ ] **Plan Badges**: In navigation / header, display the current plan (`Free`, `Pro`, `Ultra`) using `workspace.plan` from `/api/auth/me`.
- [ ] **Usage Progress Bar**: On dashboard or settings, show orders used vs limit (`usage.ordersUsed / usage.orderLimit`) from `GET /api/workspace/billing`.
- [ ] **Pricing Page / Modal**: Render the 3 tiers with a toggle between `Monthly` and `Annually`.
- [ ] **Checkout Redirect**: Connect "Upgrade" buttons to `POST /api/workspace/billing/checkout` and forward to `checkoutUrl`.
- [ ] **Manage Portal Button**: Show "Manage Subscription / Invoices" for paying customers, connecting to `POST /api/workspace/billing/portal`.
- [ ] **Model Selector Filtering**: In attribution report dropdowns, disable or badge models that require upgrade (e.g. badge `Position-Based` and `Time-Decay` with "Pro", and `Data-Driven` with "Ultra").
- [ ] **Global Error Interceptor**: Intercept `403` responses where `code` is `plan_limit_reached`, `model_upgrade_required`, or `feature_upgrade_required` to pop up the upgrade modal.

---

## 6. Platform Admin Plan Management

Platform administrators can change the plan tier or revoke paid plans for any workspace directly from the admin console.

### 1. Set Workspace Plan
Manually upgrade, downgrade, or grant a specific plan tier (Free / Pro / Ultra). Automatically synchronizes order limits and subscription status. If downgrading to Free, any active Stripe subscription is automatically cancelled.

- **Endpoint**: `PATCH /api/platform-admin/workspaces/:workspaceId/plan`
- **Auth**: Authenticated `platform_admin` session required

#### Request Body:
```json
{
  "plan": "pro",
  "billingInterval": "monthly",
  "reason": "Contract agreement upgrade",
  "cancelStripeSubscription": false
}
```
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `plan` | `string` | **Yes** | Target plan tier: `"free"`, `"pro"`, or `"ultra"`. |
| `billingInterval` | `string` | No | `"monthly"` or `"annually"` (defaults to workspace current or `"monthly"`). |
| `reason` | `string` | No | Reason recorded in the platform audit log. |
| `cancelStripeSubscription` | `boolean` | No | If changing to `"free"`, active Stripe subscription is always cancelled. Set to `true` to force cancel even when changing tiers. |

#### Response `200 OK`:
```json
{
  "message": "Workspace plan updated to Pro.",
  "data": {
    "id": "ws_123",
    "name": "Acme Marketing",
    "plan": "pro",
    "monthlyOrderLimit": 15000,
    "billingInterval": "monthly",
    "subscriptionStatus": "active",
    "cancelAtPeriodEnd": false
  }
}
```

---

### 2. Revoke Workspace Plan
Immediately revokes any paid tier (Pro / Ultra) and reverts the workspace to the default Free tier with free usage limits, cancels any active Stripe subscription, and marks subscription status as `"canceled"`.

- **Endpoint**: `POST /api/platform-admin/workspaces/:workspaceId/plan/revoke`
- **Auth**: Authenticated `platform_admin` session required

#### Request Body:
```json
{
  "reason": "Payment dispute / TOS violation",
  "cancelStripeSubscription": true
}
```
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `reason` | `string` | No | Reason recorded in the platform audit log. |
| `cancelStripeSubscription` | `boolean` | No | Defaults to `true`. Cancels active Stripe subscription via SDK. |

#### Response `200 OK`:
```json
{
  "message": "Workspace plan successfully revoked and reverted to Free tier.",
  "data": {
    "id": "ws_123",
    "name": "Acme Marketing",
    "plan": "free",
    "monthlyOrderLimit": 1000,
    "subscriptionStatus": "canceled",
    "subscriptionId": null
  }
}
```

#### Error Response `400 Bad Request` (already free):
```json
{
  "message": "Workspace is already on the Free tier.",
  "code": "already_free"
}
```


