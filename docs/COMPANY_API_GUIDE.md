# Attribution Platform — Company Integration Guide & API Reference

This guide is for **companies using the platform** and the **developers who integrate it**. It explains what the platform does, how to go live, every public API call, how payment gateways connect, how to receive webhooks, and exactly how each number is calculated.

> The internal dashboard/admin endpoints are documented in `API_DOCUMENTATION.md`. This guide covers what a company and its developers need.

**Contents**
1. [What the platform does](#1-what-the-platform-does)
2. [Go live in about 30 minutes](#2-go-live-in-about-30-minutes)
3. [Core concepts](#3-core-concepts)
4. [Authentication, keys and limits](#4-authentication-keys-and-limits)
5. [Tracking API (browser)](#5-tracking-api-browser)
6. [Conversion API (orders, bookings, refunds)](#6-conversion-api-orders-bookings-refunds)
7. [Read API (data and reports)](#7-read-api-data-and-reports)
8. [Payment gateways and other connectors](#8-payment-gateways-and-other-connectors)
9. [Outbound webhooks](#9-outbound-webhooks)
10. [How attribution works](#10-how-attribution-works)
11. [Metric definitions](#11-metric-definitions)
12. [Time, currency and money rules](#12-time-currency-and-money-rules)
13. [Team, roles, privacy and support access](#13-team-roles-privacy-and-support-access)
14. [Errors, troubleshooting and checklist](#14-errors-troubleshooting-and-checklist)

Throughout, `https://api.example.com` stands for your platform's API address. Replace it with the base URL you were given.

---

## 1. What the platform does

The platform tells you **which marketing source brought each paying customer or booking**, and shows the result as revenue, customer and booking reports you can trace back to individual orders.

```
Visitor on your website ──► records each visit as a "touch" (source, campaign, click IDs)
        │
        ▼
Checkout starts ──► you ask for a checkout token (freezes that visitor's touches)
        │
        ▼
Token is placed in the payment/booking system (Stripe metadata, Razorpay notes, ...)
        │
        ▼
Payment completes ──► the gateway webhook (or your server) sends the order to the platform
        │
        ▼
Platform matches the order to the touches, resolves the customer, and credits channels
under six attribution models ──► dashboards, reports and API
```

If no token is available, the platform falls back to matching by hashed email or phone, then by click ID, and records **how** each order was matched (see [match methods](#match-methods)).

---

## 2. Go live in about 30 minutes

### Step 1 — Create the company account (≈3 min)
`POST /api/auth/company/register` with company name, admin email, password and a 2-letter country code. A verification email is sent (the link is valid for **15 minutes**). Verify it, then sign in with `POST /api/auth/user/login`.

### Step 2 — Add and verify your website (≈5 min)
1. `POST /api/sites` with `{ "domain": "shop.example.com", "verificationMethod": "dns_txt" }` (or `"meta_tag"`).
2. Prove you own the domain using the returned instructions:
   - **DNS TXT:** create a TXT record at `_attribution-verify.shop.example.com` whose value is the returned token.
   - **Meta tag:** add `<meta name="attribution-verify" content="TOKEN">` to your home page `<head>`.
3. `POST /api/sites/:id/verify`. Live keys stay inactive until the site is verified.

### Step 3 — Create API keys (≈2 min)
`POST /api/api-keys` once per key type:
- a **publishable** key (`pk_live_…`) with `allowedOrigins: ["https://shop.example.com"]` for the browser;
- a **secret** key (`sk_live_…`) for your server.

The full key is **shown only once** — store it immediately. A workspace has one active key per type; use `POST /api/api-keys/rotate` to replace it. Use `mode: "test"` keys while building.

### Step 4 — Install tracking on your website (≈10 min)
Add the snippet from [section 5.4](#54-reference-browser-snippet) to every page. It records visits and gives you a checkout token.

### Step 5 — Connect payments (≈5 min)
Choose one:
- **Stripe / PayPal:** one-click connect (the platform creates the webhook for you) — see [section 8.1](#81-one-click-connect-stripe-paypal-razorpay).
- **Razorpay:** the platform gives you a webhook URL and secret to paste into the Razorpay dashboard.
- **Shopify, Zenoti, or your own system:** see [8.4](#84-shopify-zenoti-and-generic-connectors) or send orders yourself with the [Conversion API](#6-conversion-api-orders-bookings-refunds).

### Step 6 — Pass the checkout token to your payment system (≈5 min)
Call `getCheckoutToken()` when checkout starts and store the token in the payment system's extra data. The exact field per gateway is in the [table in 8.2](#82-where-to-put-the-checkout-token).

### Step 7 — Test and go live
Make a test purchase. In the dashboard, **Connectors** shows the connector turn *healthy* when the first event arrives, and the order appears with its **match method** (`token` is what you want). You are live.

---

## 3. Core concepts

| Term | Meaning |
|---|---|
| **Workspace** (company) | Your isolated account. Every request is scoped to it by your key or login — never by anything in the request. |
| **Site** | A website you own, verified by DNS or meta tag. |
| **Location** | A branch/outlet with its own timezone and currency (optional). |
| **Visitor** | An anonymous browser, identified by a first-party `visitorId` you generate. |
| **Touch** | One recorded visit with its source, medium, campaign, referrer, landing page and click IDs. Touches are never overwritten. |
| **Checkout token** | A short-lived code (default **2 hours**) that freezes a visitor's touches at the moment checkout starts. |
| **Customer** | A real person, resolved from hashed email/phone/external ID. Several visitors (phone, laptop) can belong to one customer. |
| **Order** | A paid order. **Booking**: an appointment, attributed when it is *created*, not when paid. |
| **Credit** | The share of an order given to a touch under an attribution model. |
| **Connector** | An inbound integration (Stripe, PayPal, Razorpay, Shopify, Zenoti, generic). |

### Match methods
Every order records how it was matched to its marketing source:

| `matchMethod` | Meaning | Confidence |
|---|---|---|
| `token` | The checkout token was present and valid | Highest |
| `click_id` | A click ID (gclid/fbclid/…) was in the payload | High |
| `email` / `phone` | The customer was linked to a known visitor by hashed email/phone | Medium |
| `none` | No match; shown as **Direct / unknown** | — |

---

## 4. Authentication, keys and limits

### Sending a key
Either header works:
```
Authorization: Bearer sk_live_xxxxxxxx
X-Api-Key: sk_live_xxxxxxxx
```

### Which key for what

| Key | Where it lives | Allowed |
|---|---|---|
| **Publishable** `pk_…` | In your website (public) | `POST /v1/touches`, `/v1/identify`, `/v1/checkout-sessions`, `/v1/orders`, `/v1/conversions`, `/v1/bookings` |
| **Secret** `sk_…` | Your server only — never in a web page or app | Everything above **plus** refunds, order/booking edits, and **all read endpoints** |

Rules enforced by the platform:
- **Publishable keys work only from their allowed origins.** A request from another website gets `403 Origin not allowed for this key`. Test-mode keys may be called without an `Origin` header (curl, Postman); live keys may not.
- **Refunds and edits (`POST /v1/refunds`, `PATCH /v1/orders/:id`, `PATCH /v1/bookings/:id`) need a secret key.** A publishable key is visible to anyone who views your page source, so it must never be able to change existing records.
- **Reading data needs a secret key.** Publishable keys are rejected on every `GET`.
- Because a publishable key is public, an order posted from the browser can be forged by a visitor. **For trustworthy revenue, send orders from your server with the secret key** (or through a gateway connector).
- A live key is inactive until its site is verified. A **suspended or closed company's keys stop working immediately** (`403 Workspace is not active`).
- Keys are stored hashed. Lost keys cannot be recovered — rotate instead.

### Rate limits
Each key has a per-minute limit (new keys default to **600/min**; configurable per key). Every response carries:

| Header | Meaning |
|---|---|
| `X-RateLimit-Limit` | Requests allowed per minute |
| `X-RateLimit-Remaining` | Requests left in the window |
| `X-RateLimit-Reset` | Unix time when the window resets |
| `Retry-After` | Seconds to wait (only on `429`) |

### Errors
All errors are JSON with a human-readable `message`:
```json
{ "message": "externalId is required" }
```
Some also include a machine-readable `code`. See [section 14](#14-errors-troubleshooting-and-checklist).

### Idempotency
Sending the same order, booking or refund twice **never double-counts**. Orders and bookings are deduplicated on `externalId` (or your `idempotencyKey` if you send one); refunds on `externalId` / `idempotencyKey`. It is always safe to retry after a timeout.

---

## 5. Tracking API (browser)

Auth: **publishable key**, sent from an allowed origin.

### 5.1 Record a touch — `POST /v1/touches`
Call on every page view (after consent, where required).

```json
{
  "visitorId": "7b0e1c2e-…",
  "touchedAt": "2026-03-01T15:30:00.000Z",
  "source": "google", "medium": "cpc", "campaign": "summer_sale",
  "term": "running shoes", "content": "ad_variant_1",
  "referrer": "https://google.com",
  "landingPage": "https://shop.example.com/shoes?utm_source=google",
  "pageTitle": "Shoes | Acme",
  "gclid": "Cj0K…", "fbclid": null, "ttclid": null, "msclkid": null,
  "fbc": null, "fbp": "fb.1.1700000000.123", "ga": "GA1.2.123.456"
}
```
Only `visitorId` is required. **Response `201`**
```json
{ "id": "…", "touchId": "…", "visitorId": "…", "visitorRecordId": "…",
  "siteId": "…", "channel": "paid_search", "touchedAt": "2026-03-01T15:30:00.000Z" }
```
A repeat visit from the same campaign within **30 minutes** is de-duplicated and returns the existing touch with `200`. The platform classifies each touch into a `channel` (for example `paid_search`, `google`, `meta`, `tiktok`, `bing`, `social`, `email`, `organic`, `direct`); a click ID outranks UTM tags, which outrank a bare referrer, which outranks direct. A later direct visit never replaces a paid click.

### 5.2 Identify a visitor — `POST /v1/identify`
Call when the visitor gives their email or phone (sign-in, enquiry form). Links the anonymous visitor to a customer, so touches from every device combine.
```json
{ "visitorId": "7b0e1c2e-…", "email": "customer@example.com", "phone": "+14155552671" }
```
**Response `200`:** `{ "customerId", "visitorId", "visitorRecordId", "touchIds": [...], "touchCount", "isNew" }`.
Email and phone are stored hashed for matching (the email is also kept encrypted).

### 5.3 Create a checkout token — `POST /v1/checkout-sessions`
Call when the visitor starts checkout or booking.
```json
{ "visitorId": "7b0e1c2e-…", "expiresInMs": 7200000 }
```
**Response `201`:** `{ "checkoutSessionId", "token": "cs_…", "visitorId", "touchIds": [...], "touchCount", "expiresAt" }`.
Put `token` into your payment/booking system — see [8.2](#82-where-to-put-the-checkout-token).

### 5.4 Reference browser snippet
A minimal, dependency-free example you can paste into your pages. Adjust `API` and `KEY`, and call it only after the visitor has consented where the law requires.

```html
<script>
(function () {
  var API = "https://api.example.com";
  var KEY = "pk_live_xxxxxxxx";               // publishable key (safe to expose)

  function cookie(name) {
    var m = document.cookie.match("(?:^|; )" + name + "=([^;]*)");
    return m ? decodeURIComponent(m[1]) : null;
  }
  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16);
      });
  }
  var visitorId = localStorage.getItem("attr_vid");
  if (!visitorId) { visitorId = uuid(); localStorage.setItem("attr_vid", visitorId); }

  function post(path, body) {
    return fetch(API + path, {
      method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  var q = new URLSearchParams(location.search);
  post("/v1/touches", {
    visitorId: visitorId,
    source: q.get("utm_source"), medium: q.get("utm_medium"), campaign: q.get("utm_campaign"),
    term: q.get("utm_term"), content: q.get("utm_content"),
    referrer: document.referrer || null, landingPage: location.href, pageTitle: document.title,
    gclid: q.get("gclid"), fbclid: q.get("fbclid"), ttclid: q.get("ttclid"), msclkid: q.get("msclkid"),
    fbc: cookie("_fbc"), fbp: cookie("_fbp"), ga: cookie("_ga")
  });

  window.Attribution = {
    identify: function (email, phone) { return post("/v1/identify", { visitorId: visitorId, email: email, phone: phone }); },
    getCheckoutToken: function () { return post("/v1/checkout-sessions", { visitorId: visitorId }).then(function (r) { return r.token; }); }
  };
})();
</script>
```
Usage when checkout starts:
```js
const token = await Attribution.getCheckoutToken();
// e.g. add it to your Stripe PaymentIntent metadata as attribution_token
```

---

## 6. Conversion API (orders, bookings, refunds)

Use these when you are **not** using a gateway connector, or to add data a connector cannot see. Amounts are in **major units** (e.g. `99.99`); the platform stores them as integer minor units.

### 6.1 Create an order — `POST /v1/orders` (alias `/v1/conversions`)
Auth: publishable or **secret** key (use the secret key from your server for trusted revenue).

| Field | Required | Notes |
|---|---|---|
| `externalId` | yes | Your order ID — also the de-duplication key |
| `orderedAt` | yes | ISO-8601 time the order was **paid** |
| `currency` | yes | 3-letter ISO code (`USD`, `INR`) |
| `grossAmount`, `netAmount` | yes | Major units |
| `discountAmount`, `taxAmount` | no | Major units |
| `checkoutToken` | no | From `/v1/checkout-sessions` |
| `visitorId` | no | Fallback when there is no token |
| `email`, `phone` | no | For customer resolution / fallback matching |
| `locationId` | no | One of your locations |
| `items` | no | `[{ name, quantity, unitAmount, currency, externalId? }]` |
| `idempotencyKey` | no | Defaults to `externalId` |

```bash
curl -X POST https://api.example.com/v1/orders \
  -H "Authorization: Bearer sk_live_xxxxxxxx" -H "Content-Type: application/json" \
  -d '{"externalId":"order_12345","orderedAt":"2026-03-01T15:45:00Z","currency":"USD",
       "grossAmount":150.00,"netAmount":140.00,"discountAmount":10.00,
       "checkoutToken":"cs_xxxxxxxx","email":"customer@example.com"}'
```
**Response `201`:**
```json
{ "id": "…", "orderId": "…", "externalId": "order_12345", "customerId": "…",
  "touchIds": ["…"], "attributionCreditIds": ["…"], "status": "paid",
  "matchMethod": "token", "isNewCustomer": true, "touchCount": 2, "currency": "USD" }
```
Credit rows are written for all six attribution models in one transaction, so any model can be shown instantly.

### 6.2 Update an order — `PATCH /v1/orders/:id` (secret key)
Edits an existing order. `404 Order not found` if it does not exist in your workspace.

### 6.3 Create a booking — `POST /v1/bookings`
Same attribution pipeline as orders, but attributed **when the booking is created**.

| Field | Required |
|---|---|
| `externalId`, `appointmentStartAt`, `currency`, `bookedValue` | yes |
| `checkoutToken`, `visitorId`, `email`, `phone`, `locationId`, `serviceName`, `appointmentEndAt`, `idempotencyKey` | no |

### 6.4 Update a booking — `PATCH /v1/bookings/:id` (secret key)
```json
{ "status": "completed", "reason": "Guest attended" }
```
`status` is one of `scheduled`, `confirmed`, `completed`, `cancelled`, `rescheduled`, `no_show`. Every change is kept in the booking's status history.

### 6.5 Record a refund — `POST /v1/refunds` (secret key)
```json
{ "externalOrderId": "order_12345", "amount": 25.00, "currency": "USD",
  "reason": "Customer request", "externalId": "re_789", "refundedAt": "2026-03-03T10:00:00Z" }
```
Use `orderId` (platform ID) **or** `externalOrderId` (your ID). The refund is linked to the order, the order becomes `partially_refunded` or `refunded`, and revenue is reduced **on the refund date**. `currency` must match the order.

---

## 7. Read API (data and reports)

Auth: **secret key** (server-side) — or a signed-in dashboard session. Responses are scoped to your workspace automatically.

### 7.1 Lists
All lists are paginated: `?page=1&limit=25` (max `limit` 100) and return
```json
{ "data": [ … ], "pagination": { "page": 1, "limit": 25, "total": 120, "pages": 5 } }
```

| Endpoint | Filters |
|---|---|
| `GET /v1/orders` | `status`, `locationId`, `from`, `to` |
| `GET /v1/orders/:id/attribution` | `model` — the order's journey and credit |
| `GET /v1/refunds` | `from`, `to` (by refund date), `locationId`, `channel`, `orderId`, `search` |
| `GET /v1/customers` | `externalIdKey` + `externalId` |
| `GET /v1/customers/:id/journey` | `model` — touches, bookings, orders, credit |
| `GET /v1/bookings` | `status`, `locationId`, `from`, `to` (by appointment time) |
| `GET /v1/bookings/upcoming` | `days` (1–90, default 7), `locationId` |

Customer email addresses are returned only to signed-in dashboard users, never through API keys.

### 7.2 Reports
`GET /v1/reports/{summary|channels|campaigns|locations|trend|customers|dashboard}`

| Parameter | Meaning |
|---|---|
| `from`, `to` | `YYYY-MM-DD` = **whole local days** in your timezone (`to` includes the entire last day); or a full ISO timestamp for an exact instant. Default: the last 30 local days ending today |
| `tz` | IANA timezone (e.g. `Asia/Kolkata`). Default: your workspace timezone |
| `model` | `first_touch`, `last_touch`, `last_non_direct` *(default)*, `linear`, `time_decay`, `position_based` |
| `locationId` | Restrict to one location |

Every report returns `period: { from, to, tz }` so you can see exactly which window was used. Invalid dates or timezones return `400`.

**Summary** (`/v1/reports/summary`) — example:
```json
{
  "period": { "from": "2026-02-01T18:30:00.000Z", "to": "2026-03-02T18:29:59.999Z", "tz": "Asia/Kolkata" },
  "currency": "USD", "model": "last_non_direct",
  "revenue":  { "grossMinorUnits": "1500000", "discountsMinorUnits": "50000", "refundsMinorUnits": "20000",
                "netMinorUnits": "1430000", "averageOrderValueMinorUnits": 14300 },
  "orders":   { "total": 100, "newCustomers": 61, "returningCustomers": 39 },
  "attribution": { "attributedRevenueMinorUnits": "1200000", "coverageRate": 83.9 },
  "bookings": { "total": 40, "scheduled": 22, "cancelled": 5, "bookedValueMinorUnits": "300000", "cancellationRate": 12.5 }
}
```
- **Channels / campaigns:** revenue by source. An order whose credit is split across channels (linear, time decay, position based) appears in each channel it touched, with that channel's share of the revenue.
- **Locations:** per location, plus a "(No location)" row for unassigned orders.
- **Trend:** one row per **local day** (`date`, `orders`, `netMinorUnits`, `newCustomers`).
- **Customers:** `newCustomers`, `returningCustomers`, `totalCustomers`, `repeatRate`.
- **Dashboard:** an all-in-one overview used by the dashboard.

> **Drill-down always adds up.** Lists use the same local-day rule as reports, so the orders listed for a date range sum to that range's report total.

Money is always returned as **strings in minor units** (cents/paise) so large values never lose precision.

---

## 8. Payment gateways and other connectors

Every connector converts the source's event into the same internal event, stores the **raw payload first** (so failures can be replayed), verifies the sender's signature, and de-duplicates by the source's own IDs.

### 8.1 One-click connect (Stripe, PayPal, Razorpay)

All calls need a signed-in **company admin**. Replace the host with your API address.

**See what is supported and whether the server is ready**
```
GET /api/workspace/connectors/gateways
```
If `ready` is `false`, the response's `problem` explains why (the server's public address must be a public HTTPS URL, because gateways only send webhooks to HTTPS).

**Connect**
```
POST /api/workspace/connectors/connect
```
| Gateway | Body | What happens |
|---|---|---|
| **Stripe** | `{ "type": "stripe", "credentials": { "secretKey": "sk_live_… or rk_live_…" } }` | The platform creates the webhook endpoint at Stripe and stores its signing secret (encrypted). **Your API key is used once and is not stored.** A restricted key needs *Write* access to *Webhook Endpoints*. |
| **PayPal** | `{ "type": "paypal", "credentials": { "environment": "live", "clientId": "…", "clientSecret": "…" } }` | The platform creates the webhook through PayPal. Client ID/secret are stored encrypted (needed to verify each event). |
| **Razorpay** | `{ "type": "razorpay" }` | Razorpay only allows API-created webhooks for partner accounts. The response contains a **webhook URL and secret — shown once** — that you paste into **Razorpay Dashboard → Account & Settings → Webhooks**, ticking `payment.captured` and `refund.processed`. |

Optional `name` labels the connector. A successful connect returns `201` with the connector, its `webhookUrl`, and `setup` (Razorpay only). The connector is **pending** until the first verified event arrives, then **healthy**.

Possible errors: `400 invalid_credentials` (gateway rejected the credentials), `409 already_connected` (this gateway account is already connected), `422` (gateway refused the request), `502 unavailable` (gateway unreachable — retry).

**Manage**
| Call | Purpose |
|---|---|
| `GET /api/workspace/connectors` | List connectors with status, last event and webhook URL |
| `GET /api/workspace/connectors/:id` | One connector (never returns secrets) |
| `POST /api/workspace/connectors/:id/verify` | Health checks: secret stored, remote webhook still exists, correct URL, events subscribed, first event received |
| `POST /api/workspace/connectors/:id/reconnect` | New credentials, or rotate the Razorpay secret. Also re-enables a disconnected connector |
| `POST /api/workspace/connectors/:id/disconnect` | Stops the connector. Body `{ "credentials": { "secretKey": "…" } }` (Stripe) lets the platform delete the webhook at Stripe; otherwise it tells you to delete it by hand. History is kept |
| `GET /api/workspace/connectors/:id/events` | Event log (`?status=failed`) |
| `GET /api/workspace/connectors/:id/events/:eventId` | One event **with its raw payload** (admins only; may contain customer data) |
| `POST /api/workspace/connectors/:id/events/:eventId/replay` | Re-run a failed event |
| `POST /api/workspace/connectors/:id/events/replay-failed` | Re-run recent failed events, oldest first (`limit` ≤ 50) |

**Statuses:** `pending` (waiting for first event) → `healthy`; `failing` after a processing error (returns to `healthy` on the next good event); `disabled` after disconnect — events for a disabled connector are acknowledged and ignored.

### 8.2 Where to put the checkout token

| System | Put the token here |
|---|---|
| Stripe PaymentIntent | `metadata.attribution_token` |
| Stripe Checkout Session | `metadata.attribution_token` **and** `payment_intent_data.metadata.attribution_token` (or `client_reference_id`) |
| Razorpay | `notes.attribution_token` |
| PayPal | `custom_id` on the purchase unit |
| Shopify | Cart/note attribute named `attribution_token` |
| Zenoti | Appointment notes containing `attribution_token:<token>` |
| Your own system | `checkoutToken` field of `POST /v1/orders` |

> **Stripe Checkout tip:** put the token on the PaymentIntent too (`payment_intent_data.metadata`). Stripe may deliver `payment_intent.succeeded` before `checkout.session.completed`; the first event creates the order, so the token must be present on that first event.

### 8.3 Events handled

| Gateway | Orders | Refunds |
|---|---|---|
| Stripe | `payment_intent.succeeded`, `checkout.session.completed`, `checkout.session.async_payment_succeeded` | `charge.refunded` (every refund on the charge), `charge.refund.updated` |
| PayPal | `PAYMENT.CAPTURE.COMPLETED` | `PAYMENT.CAPTURE.REFUNDED` |
| Razorpay | `payment.captured`, `order.paid` | `refund.processed` |

A refund that arrives **before** its order fails with a clear message and is kept; replay it once the order exists.

### 8.4 Shopify, Zenoti and generic connectors
- **Shopify** (`orders/paid`, `orders/create`, `refunds/create`) and **Zenoti** (appointments, invoices) are created with `POST /api/workspace/connectors` (`type`, `name`, and the shared secret in `config`). The response returns the webhook URL to register in that system.
- **Generic** (`generic`, `woocommerce`, `square`) lets **any system** integrate without code on our side: configure a signature secret and a `fieldMap` that points to where `externalId`, `orderedAt`, `currency`, `grossAmount`, `email`, `checkoutToken`, … sit in your payload.
- Webhook URLs look like `https://api.example.com/api/connectors/<type>/webhook/<connectorId>`.
- Updating a connector (`PATCH`) **merges** the config you send (secrets are re-encrypted); send a key as `null` to remove it.

### 8.5 What the platform guarantees for connectors
- The raw payload is stored **before** processing; a failure never loses an event.
- Signatures are always verified (Stripe timestamp + HMAC, Razorpay/Shopify/Zenoti/generic HMAC, PayPal's verification API).
- Duplicate deliveries never create duplicate orders or refunds.
- A suspended company's connectors acknowledge and ignore events.

---

## 9. Outbound webhooks

Get notified when something happens. Manage endpoints at `/api/workspace/webhooks` (company admin):

| Call | |
|---|---|
| `POST /api/workspace/webhooks` | `{ "url": "https://you.example.com/hook", "eventTypes": ["order.created"] }` → returns a **`signingSecret` shown once** |
| `GET`, `PATCH /:id`, `DELETE /:id` | List / change / remove endpoints |

**Event types:** `order.created`, `order.updated`, `booking.created`, `booking.updated`, `refund.created`.

**Delivery** is a `POST` with JSON body:
```json
{ "id": "evt-uuid", "type": "order.created", "createdAt": "2026-03-01T15:45:01.000Z",
  "workspaceId": "…", "data": { "orderId": "…", "externalId": "order_12345", "status": "paid", "matchMethod": "token", "...": "..." } }
```
Headers: `X-Webhook-Signature`, `X-Webhook-Timestamp` (milliseconds), `X-Webhook-Event`, `User-Agent: AttributionPlatform-Webhook/1.0`.

**Verify the signature** — it is the hex HMAC-SHA256 of the **raw request body** using your signing secret.

Node.js:
```js
import crypto from "node:crypto";
app.post("/hook", express.raw({ type: "application/json" }), (req, res) => {
  const expected = crypto.createHmac("sha256", process.env.WEBHOOK_SECRET).update(req.body).digest("hex");
  const given = String(req.headers["x-webhook-signature"] || "");
  const ok = given.length === expected.length &&
             crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return res.status(401).end();
  const event = JSON.parse(req.body);   // handle event, then:
  res.status(200).end();
});
```
Python:
```python
import hmac, hashlib
def valid(raw_body: bytes, header: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header or "")
```

**Delivery rules**
- Respond with a `2xx` within **10 seconds**. Failures are retried up to **3 times** (about 1 s, 5 s, 15 s apart).
- After **10 consecutive failures** the endpoint is disabled automatically.
- Deliveries are **at-least-once**: de-duplicate on the event `id`.
- The timestamp header is **not part of the signed content**; rely on the signature and the event `id`, not the timestamp, to reject replays.

---

## 10. How attribution works

1. **Collect.** Every visit is stored as a touch. Nothing is overwritten.
2. **Freeze.** The checkout token snapshots the touches that existed when checkout began.
3. **Match.** When the order arrives the platform uses, in order: the **token**, then a **click ID** in the payload, then **email/phone** linked to a known visitor, otherwise **none**.
4. **Filter.** Only touches inside the **lookback window** count (default **30 days**, configurable per channel type). If a paid click exists, direct visits are dropped.
5. **Credit.** Each model splits the order's net revenue across the remaining touches.

| Model | Credit rule |
|---|---|
| `first_touch` | 100% to the first touch |
| `last_touch` | 100% to the last touch |
| `last_non_direct` *(default)* | 100% to the last touch that is not direct |
| `linear` | Equal share to every touch |
| `time_decay` | More credit to touches closer to the order (half-life 7 days) |
| `position_based` | 40% first, 40% last, 20% shared across the middle |

**Example.** Meta click → Google click → purchase: first touch = Meta, last touch = Google, linear = 50% / 50%.

**Customer merging.** If two customer records are the same person, a company admin can merge them (`POST /api/workspace/customers/merge` with `{ "sourceId", "targetId" }`). Visits, orders and bookings combine under the target, and **new vs returning is recalculated** over the combined history. Credit already given to past orders is not recalculated by a merge.

---

## 11. Metric definitions

One definition per metric, used identically in the dashboard, API and exports.

| Metric | Definition |
|---|---|
| Gross revenue | Sum of paid order totals before discounts and refunds, excluding tax |
| Discounts | Total discounts applied to paid orders |
| Refunds | Refund amounts, counted **on the refund date**, linked to the original order |
| Net revenue | Gross − discounts − refunds |
| Orders | Count of paid orders (unpaid or voided are excluded) |
| Average order value | Net revenue ÷ orders |
| **New customer** | A customer whose order is their **first paid order** in the company, by order time after identity resolution. An order that was later refunded still counts as an earlier paid order |
| **Returning customer** | A customer with at least one earlier paid order |
| Repeat rate | Customers with 2+ paid orders ÷ customers with 1+, in the period |
| Attributed revenue | Net revenue × the credit share under the selected model |
| Attribution coverage | Revenue with a known source ÷ total revenue |
| Booked value | Sum of service prices on bookings with status scheduled or confirmed |
| Realized revenue | Net revenue from paid orders |
| Cancellation rate | Cancelled bookings ÷ created bookings in the period |
| Lead time | Appointment start − booking created time |
| Days to convert | First touch time to order time |

New-vs-returning is decided when the order is ingested and stored on the order; it is recomputed only on a customer merge or a backfill.

---

## 12. Time, currency and money rules

- **A day is your company's local day**, in your IANA timezone (for example `Asia/Kolkata`). "Last 7 days" means the 7 local days ending today, with today included.
- Reports honour **daylight-saving changes**: a local day can be 23 or 25 hours long, and its boundaries are always local midnight.
- `from=2026-03-02&to=2026-03-02` means the whole local day of 2 March. Send full ISO timestamps if you need exact instants.
- All timestamps are stored and returned in **UTC (ISO-8601)**.
- Money is stored as **integer minor units** plus a currency code; API responses return minor units as strings.
- **Tax is excluded** from revenue unless your company chooses otherwise.
- Refunds reduce revenue on the **refund date**.

---

## 13. Team, roles, privacy and support access

### Roles
| Role | Can do |
|---|---|
| **Company admin** | Manage team, sites, locations, API keys, connectors, webhooks, settings; see all data |
| **Company viewer** | Read-only dashboard, optionally limited to certain locations |
| **Platform support** | Our staff. See the next section |

### Platform support access is transparent
Our support staff can open your dashboard **only inside a support session**:
- a **written reason** (at least 10 characters) is required,
- the session is **short-lived** (30 minutes by default, 2 hours at most) and can be ended early,
- **personal data is masked by default** — unmasking must be requested explicitly and is flagged,
- you can see every session — who, why, when it started and ended, whether data was masked:

```
GET /api/workspace/support-access        (company admin)
```
```json
{ "data": [ { "id": "…", "supportAgent": "Asha (Support)", "reason": "Investigating ticket 4821",
              "maskPii": true, "startedAt": "…", "expiresAt": "…", "endedAt": null } ] }
```

### Privacy and security
- Email and phone are stored **hashed** for matching; email is also kept **encrypted**. Secrets (gateway credentials, signing secrets) are encrypted at rest.
- Every request is scoped to your company by your key or login. One company can never read another's data.
- API keys and webhook secrets are shown **once**. Rotate if exposed.
- Collect visits only after consent where the law requires it (GDPR, UK GDPR, DPDP, CCPA): load the tracking snippet after the visitor consents.

---

## 14. Errors, troubleshooting and checklist

### Status codes
| Code | Meaning |
|---|---|
| `200` / `201` | Success / created |
| `400` | Invalid input (the `message` says which field) — including bad dates or timezone |
| `401` | Missing, invalid or revoked key / not signed in |
| `403` | Wrong key type for this route, origin not allowed, site not verified, workspace not active, or missing permission |
| `404` | Not found in **your** workspace |
| `409` | Conflict (already exists / already merged / connector has data) |
| `422` | The gateway or downstream rule refused the request |
| `429` | Rate limit exceeded — wait `Retry-After` seconds |
| `502` | A payment gateway could not be reached — retry |
| `500` | Unexpected error — safe to retry idempotent calls |

### Common problems
| Symptom | Cause and fix |
|---|---|
| `403 Origin not allowed for this key` | Add the exact origin (`https://shop.example.com`, no path) to the key's `allowedOrigins`, or call from the right site |
| `403 Origin header required` | Live publishable keys must be called from a browser. Use a test key for curl/Postman |
| `403 Site is not verified yet` | Complete domain verification (section 2, step 2) |
| `403 This key type cannot call this route` | Reads, refunds and edits need a **secret** key |
| `403 Workspace is not active` | The company is suspended or closed — contact support |
| Orders show `matchMethod: none` | The token did not reach the payment system. Check the field in [8.2](#82-where-to-put-the-checkout-token) and that the token has not expired (2 h) |
| Connector stuck on `pending` | No signed event has arrived yet. Run **verify**, confirm the webhook in the gateway dashboard points to the connector's URL, and make a test payment |
| Connector `failing` | Open the event log, filter `failed`, read each event's error, fix the cause, then **replay** |
| Refund event failed with "Order not found" | The refund arrived before the order. Replay it after the order is recorded |
| Revenue differs between a list and a report | Check both use the same `tz` and `model`; `from`/`to` as dates are whole local days |
| `409 already_connected` | That Stripe/PayPal account is already connected — use **reconnect** on the existing connector |

### Go-live checklist
- [ ] Company registered and email verified
- [ ] Site added and **verified**
- [ ] Publishable key (with allowed origins) and secret key created and stored safely
- [ ] Tracking snippet on every page; visits appear
- [ ] Checkout token passed into the payment/booking system
- [ ] Gateway connected; connector turned **healthy**
- [ ] Test purchase shows `matchMethod: token` and the right channel
- [ ] Test refund reduces revenue on its date
- [ ] Timezone, currency, default model and lookback window set
- [ ] Team invited with the right roles
- [ ] Webhook endpoint (optional) created and signature verification tested
