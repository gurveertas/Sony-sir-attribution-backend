# Attribution System — Frontend API Integration Specification

> **Base URL (Local):** `http://localhost:5000`  
> **Base URL (Production):** Set via environment variable (e.g., `https://api.yourdomain.com`)  
> **Default Content-Type:** `application/json`

---

## 1. Authentication & Security Architecture

The backend exposes **three distinct authentication models**. Frontend developers must configure requests according to the API group:

### A. Dashboard & Management APIs (`/api/*`)
* **Mechanism:** HTTP-only cookie named `user_token` containing a signed JWT (`{ id, role, name, email, workspaceId }`).
* **Frontend Requirement:** Every request made with `fetch` or `axios` **must** include credentials:
  * Fetch: `credentials: "include"`
  * Axios: `withCredentials: true`
* **Roles:**
  * `company_admin`: Full access to company settings, team, sites, API keys, connectors, reports.
  * `company_viewer`: Read-only access to team, locations, and dashboard metrics.
  * `platform_admin`: Super-admin access across workspaces (`/api/platform-admin/*`).

### B. Public & Browser SDK APIs (`/v1/*`)
* **Mechanism:** Bearer token or custom header via API Key:
  * Header: `Authorization: Bearer <API_KEY>` or `X-Api-Key: <API_KEY>`
* **Key Types:**
  * `publishable` (`pk_live_...` or `pk_test_...`): Public, browser-safe. Allowed on the tracking routes (`/v1/touches`, `/v1/identify`, `/v1/checkout-sessions`) and on order/booking *ingestion* (`POST /v1/orders`, `/v1/conversions`, `/v1/bookings`). Origin verification is enforced against the allowed origins of the key. Never accepted for refunds, edits or reads.
  * `secret` (`sk_live_...` or `sk_test_...`): Server-to-server. The only key type accepted for refunds (`POST /v1/refunds`), edits (`PATCH /v1/orders/:id`, `PATCH /v1/bookings/:id`) and **all read endpoints** (`GET /v1/orders`, `/v1/customers`, `/v1/bookings`, `/v1/reports/*`). Dashboard users keep using their session cookie on the same read routes.
  * A suspended or closed workspace's keys stop working immediately (`403 Workspace is not active`).
* **Tenant Isolation:** The `workspaceId` is derived strictly from the verified API key hash.

### C. Inbound Connector Webhooks (`/api/connectors/*`)
* **Mechanism:** Provider-specific webhook verification: Stripe timestamped signatures, Shopify/Razorpay/Zenoti HMAC, and PayPal's verification API.
* **Target Audience:** External webhook providers and integrations.

---

## 2. Standard Responses & Enums

### Standard Error Response Format
```json
{
  "message": "Human-readable error description"
}
```

### Standard Pagination Schema
Endpoints returning paginated data provide:
```json
{
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 25,
    "total": 120,
    "pages": 5
  }
}
```

### Key Enums Reference
* **WorkspaceStatus:** `active`, `suspended`, `closed`
* **UserRole:** `platform_admin`, `company_admin`, `company_viewer`
* **UserStatus:** `active`, `deactivated`
* **ApiKeyMode:** `test`, `live`
* **ApiKeyType:** `publishable`, `secret`
* **VerificationMethod:** `dns_txt`, `meta_tag`
* **Attribution Models:** `first_touch`, `last_touch`, `last_non_direct`, `linear`, `time_decay`, `position_based`
* **BookingStatus:** `scheduled`, `confirmed`, `completed`, `cancelled`, `rescheduled`, `no_show`
* **OrderStatus:** `pending`, `paid`, `partially_refunded`, `refunded`, `voided`
* **ConnectorType:** `zenoti`, `stripe`, `shopify`, `razorpay`, `generic`, `woocommerce`, `paypal`, `square`
* **ConnectorStatus:** `pending`, `healthy`, `failing`, `disabled`

---

## 3. Authentication & Account APIs (`/api/auth`)

### 3.1 Register Company
Creates workspace, admin user account, sets auth cookie, and sends email verification.
* **Method:** `POST`
* **Endpoint:** `/api/auth/company/register`
* **Auth:** None (Public)
* **Request Body:**
  ```json
  {
    "name": "Acme Corp",
    "email": "admin@acme.com",
    "password": "StrongPassword123!",
    "adminName": "John Doe",
    "country": "US",
    "timezone": "America/New_York",
    "currency": "USD",
    "industry": "Ecommerce",
    "dataRegion": "us"
  }
  ```
* **Required Fields:** `name`, `email`, `password`, `country` (2-char ISO).
* **Response `201 Created`:**
  ```json
  {
    "message": "Company registered successfully. Verification email sent.",
    "workspaceId": "ws-uuid",
    "slug": "acme-corp-a1b2",
    "userId": "user-uuid"
  }
  ```
  *(Also sets `user_token` HTTP-only cookie)*

### 3.2 User Login
Authenticates user and sets session cookie.
* **Method:** `POST`
* **Endpoint:** `/api/auth/user/login`
* **Auth:** None (Public)
* **Request Body:**
  ```json
  {
    "email": "admin@acme.com",
    "password": "StrongPassword123!"
  }
  ```
* **Response `200 OK`:** Sets `user_token` cookie.
  ```json
  {
    "message": "User verified"
  }
  ```

### 3.3 Verify Email
Validates the token sent in the confirmation email and activates the workspace.
* **Method:** `POST`
* **Endpoint:** `/api/auth/verify-user`
* **Auth:** None (Public)
* **Request Body / Query Parameter:**
  ```json
  {
    "verifytoken": "64_char_hex_token"
  }
  ```
  *(Or `GET /api/auth/verify-user?verifytoken=...`)*
* **Response `200 OK`:**
  ```json
  {
    "message": "Email verified successfully. You can now log in.",
    "workspaceId": "ws-uuid",
    "slug": "acme-corp-a1b2"
  }
  ```

### 3.4 Forgot Password
Initiates password reset flow by emailing a cryptographically signed 1-hour reset link.
* **Method:** `POST`
* **Endpoint:** `/api/auth/user/forgotpass`
* **Auth:** None (Public)
* **Request Body:**
  ```json
  {
    "email": "admin@acme.com"
  }
  ```
* **Response `200 OK`:**
  ```json
  {
    "message": "Password reset instructions have been sent to your email."
  }
  ```

### 3.5 Reset Password
Completes the password reset flow using the token from the email link.
* **Method:** `POST`
* **Endpoint:** `/api/auth/reset-password` *(or `/api/auth/user/reset-password`)*
* **Auth:** None (Public)
* **Request Body:**
  ```json
  {
    "token": "signed_jwt_reset_token",
    "newPassword": "NewStrongPassword123!"
  }
  ```
* **Response `200 OK`:**
  ```json
  {
    "message": "Password has been reset successfully. You can now log in with your new password."
  }
  ```
* **Error `400 Bad Request`:**
  ```json
  {
    "message": "Reset token has expired or is invalid"
  }
  ```

### 3.6 Get Current User (Session Check)
Decodes the active JWT cookie and returns authenticated user info.
* **Method:** `GET`
* **Endpoint:** `/api/auth/me`
* **Auth:** Cookie (`user_token`)
* **Response `200 OK`:**
  ```json
  {
    "message": "Token decoded",
    "decoded": {
      "id": "user-uuid",
      "role": "company_admin",
      "name": "John Doe",
      "email": "admin@acme.com",
      "workspaceId": "ws-uuid",
      "iat": 1718000000,
      "exp": 1718604800
    }
  }
  ```

### 3.6 Logout
Clears the session cookie.
* **Method:** `POST`
* **Endpoint:** `/api/auth/logout`
* **Auth:** None / Cookie
* **Response `200 OK`:** Clears `user_token` cookie.
  ```json
  {
    "message": "Logged out successfully"
  }
  ```

---

## 4. User Profile APIs (`/api/user`)

### 4.1 Update Profile & Company Details
Allows updating company metadata and/or the current admin's display name.
* **Method:** `PATCH`
* **Endpoint:** `/api/user/update-details`
* **Auth:** Cookie (`user_token`)
* **Request Body:** *(Provide at least one)*
  ```json
  {
    "name": "Acme Updated Corp",
    "adminName": "Johnathan Doe",
    "country": "US",
    "timezone": "America/Chicago",
    "currency": "USD",
    "industry": "SaaS"
  }
  ```
* **Response `200 OK`:**
  ```json
  {
    "message": "Company details updated successfully",
    "workspace": {
      "id": "ws-uuid",
      "name": "Acme Updated Corp",
      "slug": "acme-corp-a1b2",
      "country": "US",
      "timezone": "America/Chicago",
      "reportingCurrency": "USD",
      "industry": "SaaS"
    },
    "user": {
      "id": "user-uuid",
      "name": "Johnathan Doe",
      "email": "admin@acme.com",
      "role": "company_admin"
    }
  }
  ```

---

## 5. Sites & Domain Verification APIs (`/api/sites`)
*All routes require role `company_admin`.*

### 5.1 Add Site
Registers a domain to track and generates ownership verification instructions.
* **Method:** `POST`
* **Endpoint:** `/api/sites`
* **Request Body:**
  ```json
  {
    "domain": "example.com",
    "verificationMethod": "dns_txt"
  }
  ```
  *(Methods: `"dns_txt"` or `"meta_tag"`)*
* **Response `201 Created`:**
  ```json
  {
    "id": "site-uuid",
    "domain": "example.com",
    "allowedOrigins": ["https://example.com", "https://www.example.com"],
    "verificationMethod": "dns_txt",
    "verifiedAt": null,
    "instructions": {
      "type": "TXT",
      "host": "_attribution-verify.example.com",
      "value": "48_char_token"
    }
  }
  ```

### 5.2 List Sites
* **Method:** `GET`
* **Endpoint:** `/api/sites`
* **Response `200 OK`:**
  ```json
  {
    "data": [
      {
        "id": "site-uuid",
        "domain": "example.com",
        "allowedOrigins": ["https://example.com"],
        "verificationMethod": "dns_txt",
        "verifiedAt": "2026-03-01T12:00:00.000Z",
        "createdAt": "2026-02-28T10:00:00.000Z",
        "instructions": null
      }
    ]
  }
  ```

### 5.3 Get Site Details
* **Method:** `GET`
* **Endpoint:** `/api/sites/:id`
* **Response `200 OK`:** Site object with instructions if unverified.

### 5.4 Update Site Configuration
Update allowed CORS origins or change verification method (restarts verification).
* **Method:** `PATCH`
* **Endpoint:** `/api/sites/:id`
* **Request Body:**
  ```json
  {
    "allowedOrigins": ["https://example.com", "https://shop.example.com"],
    "verificationMethod": "meta_tag"
  }
  ```
* **Response `200 OK`:** Updated site object.

### 5.5 Delete Site
Revokes all associated active API keys and removes the site.
* **Method:** `DELETE`
* **Endpoint:** `/api/sites/:id`
* **Response `204 No Content`**

### 5.6 Verify Domain Ownership
Performs live DNS TXT lookup or homepage meta tag scrape to verify control.
* **Method:** `POST`
* **Endpoint:** `/api/sites/:id/verify-domain`
* **Response `200 OK` (Verified):**
  ```json
  {
    "verified": true,
    "message": "Domain verified"
  }
  ```
* **Response `422 Unprocessable Entity` (Not verified yet):**
  ```json
  {
    "verified": false,
    "message": "TXT record not found yet. DNS changes can take a few minutes to hours to appear.",
    "instructions": { ... }
  }
  ```

---

## 6. API Key Management APIs (`/api/api-keys`)
*All routes require role `company_admin`. Note: Workspace enforces a strict **one active key** policy.*

### 6.1 Create API Key
Creates an API key. Plaintext key `key` is returned **only once** upon creation.
* **Method:** `POST`
* **Endpoint:** `/api/api-keys`
* **Request Body:**
  ```json
  {
    "name": "Production Storefront Key",
    "mode": "live",
    "allowedOrigins": ["https://example.com", "https://checkout.example.com"],
    "siteId": "site-uuid"
  }
  ```
* **Response `201 Created`:**
  ```json
  {
    "id": "key-uuid",
    "name": "Production Storefront Key",
    "mode": "live",
    "keyPrefix": "wk_live_a1b2",
    "siteId": "site-uuid",
    "allowedOrigins": ["https://example.com", "https://checkout.example.com"],
    "rateLimitPerMin": 600,
    "lastUsedAt": null,
    "expiresAt": null,
    "rotatedFromId": null,
    "revokedAt": null,
    "createdAt": "2026-03-01T12:00:00.000Z",
    "key": "wk_live_abc123... (STORE SAFELY)"
  }
  ```

### 6.2 List API Keys
* **Method:** `GET`
* **Endpoint:** `/api/api-keys`
* **Query Parameters:**
  * `includeRevoked`: `"true"` | `"false"` (default: `"false"`)
* **Response `200 OK`:**
  ```json
  {
    "data": [
      {
        "id": "key-uuid",
        "name": "Production Storefront Key",
        "mode": "live",
        "keyPrefix": "wk_live_a1b2",
        "siteId": "site-uuid",
        "allowedOrigins": ["https://example.com"],
        "rateLimitPerMin": 600,
        "lastUsedAt": "2026-03-02T10:00:00.000Z",
        "revokedAt": null,
        "createdAt": "2026-03-01T12:00:00.000Z"
      }
    ]
  }
  ```

### 6.3 Update API Key
* **Method:** `PATCH`
* **Endpoint:** `/api/api-keys/:id`
* **Request Body:**
  ```json
  {
    "name": "New Key Name",
    "allowedOrigins": ["https://newdomain.com"]
  }
  ```
* **Response `200 OK`:** Updated key object.

### 6.4 Revoke API Key
Immediately revokes the key.
* **Method:** `DELETE`
* **Endpoint:** `/api/api-keys/:id`
* **Response `204 No Content`**

### 6.5 Rotate API Key
Revokes old active key and creates a replacement with the same settings atomically without downtime.
* **Method:** `POST`
* **Endpoint:** `/api/api-keys/rotate`
* **Response `201 Created`:** New key object containing full `key` string.

---

## 7. Workspace Management APIs (`/api/workspace`)

### 7.1 Settings
* **Get Settings:** `GET /api/workspace/settings` (Role: `company_admin`)
  * **Response `200 OK`:**
    ```json
    {
      "data": {
        "id": "ws-uuid",
        "name": "Acme Corp",
        "slug": "acme-corp-1234",
        "timezone": "UTC",
        "weekStart": 1,
        "reportingCurrency": "USD",
        "industry": "Retail",
        "websiteUrl": "https://example.com",
        "defaultModel": "last_non_direct",
        "lookbackDays": 30,
        "lookbackOverrides": {},
        "consentMode": "off",
        "rawRetentionMonths": 13
      }
    }
    ```
* **Update Settings:** `PATCH /api/workspace/settings` (Role: `company_admin`)
  * **Request Body:** Whitelist of fields above (e.g. `{"defaultModel": "linear", "lookbackDays": 60}`)

### 7.2 Team & Invites
* **Send Invite:** `POST /api/workspace/invites` (Role: `company_admin`)
  * **Body:**
    ```json
    {
      "email": "teammate@example.com",
      "role": "company_viewer",
      "allowedLocationIds": ["loc-uuid-1"]
    }
    ```
  * **Response `201 Created`:** `{"message": "Invite sent", "email": "teammate@example.com"}`
* **List Invites:** `GET /api/workspace/invites?status=open|pending|expired|accepted|revoked|all` (Role: `company_admin`; default `open` = pending + expired). Each row: `id, email, role, allowedLocationIds, status, invitedByName, expiresAt, createdAt`.
* **Edit Invite:** `PATCH /api/workspace/invites/:id` `{ role?, allowedLocationIds? }` (pending or expired invites only).
* **Resend Invite:** `POST /api/workspace/invites/:id/resend`: a new link valid 7 days. The previous link stops working. Answers `502 email_failed` if the email could not be sent.
* **Delete Invite:** `DELETE /api/workspace/invites/:id`: revokes the link (the row is kept for the audit log). `409` once the invite was accepted.
* Email links (invite, verification, password reset) point to the dashboard origin the request came from when it is an allowed origin, otherwise to `FRONTEND_URL`.
* **Accept Invite:** `POST /api/workspace/invites/accept` (Public)
  * **Body:**
    ```json
    {
      "token": "hex_token_from_email",
      "password": "Password123!",
      "name": "Jane Teammate"
    }
    ```
  * **Response `200 OK`:** `{"message": "Invite accepted. You can now log in."}`
* **List Team:** `GET /api/workspace/team` (Role: `company_admin`, `company_viewer`)
  * **Response `200 OK`:** `{"data": [{ "id": "...", "name": "...", "email": "...", "role": "...", "status": "..." }]}`
* **Update Team Member:** `PATCH /api/workspace/team/:userId` (Role: `company_admin`)
  * **Body:** `{"role": "company_admin"}` or `{"status": "deactivated"}`

### 7.3 Locations
* **List Locations:** `GET /api/workspace/locations` (Role: `company_admin`, `company_viewer`)
* **Create Location:** `POST /api/workspace/locations` (Role: `company_admin`)
  * **Body:**
    ```json
    {
      "name": "Downtown Branch",
      "timezone": "America/New_York",
      "currency": "USD",
      "externalIds": { "posLocationId": "LOC_99" }
    }
    ```
* **Update Location:** `PATCH /api/workspace/locations/:id` (Role: `company_admin`)
  * **Body:** `{"name": "...", "timezone": "...", "currency": "...", "isActive": true}`
* **Delete Location:** `DELETE /api/workspace/locations/:id` (Role: `company_admin`) -> `204 No Content`

### 7.4 Channel Mapping Rules
Custom priority rules overriding default attribution channel classifications.
* **List Rules:** `GET /api/workspace/channel-rules`
* **Create Rule:** `POST /api/workspace/channel-rules`
  * **Body:**
    ```json
    {
      "priority": 1,
      "channel": "paid_social_influencer",
      "match": { "utm_medium": "influencer", "utm_source": "instagram" },
      "isActive": true
    }
    ```
* **Update Rule:** `PATCH /api/workspace/channel-rules/:id`
* **Delete Rule:** `DELETE /api/workspace/channel-rules/:id`

### 7.5 Outbound Webhooks
Webhooks triggered to external customer endpoints on events.
* **List Endpoints:** `GET /api/workspace/webhooks`
* **Create Endpoint:** `POST /api/workspace/webhooks`
  * **Body:**
    ```json
    {
      "url": "https://client-webhook.com/endpoint",
      "eventTypes": ["order.created", "booking.created"]
    }
    ```
  * **Response `201 Created`:** Includes `signingSecret` (shown once).
* **Update Endpoint:** `PATCH /api/workspace/webhooks/:id` (`{"isActive": false, "eventTypes": [...]}`)
* **Delete Endpoint:** `DELETE /api/workspace/webhooks/:id`

### 7.6 Audit Log
Paginated list of actions in this workspace.
* **Method:** `GET`
* **Endpoint:** `/api/workspace/audit-log`
* **Query:** `page`, `limit`
* **Response `200 OK`:** Paginated audit log records.

### 7.7 Inbound Connector Integrations Management
* **List Connectors:** `GET /api/workspace/connectors`
* **Create Connector:** `POST /api/workspace/connectors`
  * **Body:**
    ```json
    {
      "type": "stripe",
      "name": "Stripe Payments",
      "config": { "webhookSecret": "whsec_..." }
    }
    ```
  * **Response `201 Created`:** Returns connector details including generated `webhookUrl` to configure inside Stripe/Shopify/etc.
* **Update Connector:** `PATCH /api/workspace/connectors/:id` (`{"name": "...", "config": {...}, "status": "pending"|"healthy"|"disabled"}`). `config` is **merged** into the existing config (secrets are re-encrypted and survive); send a key as `null` to remove it. Gateway-managed keys (`webhookSecret`, `webhookId`, `webhookEndpointId`, `clientId`, `clientSecret`, ...) cannot be changed here — use reconnect.
* **Delete Connector:** `DELETE /api/workspace/connectors/:id` — only for connectors that never received data; otherwise `409 connector_has_data` (use disconnect, section 11.1).
* **List Connector Events (Feed):** `GET /api/workspace/connectors/:id/events?status=failed&page=1`
* **Replay Failed Event:** `POST /api/workspace/connectors/:id/events/:eventId/replay` (`{"force": true}` to retry `dead` events). Re-runs the stored payload through the same processor as the live webhook; safe to repeat (orders/refunds are de-duplicated on the gateway's IDs). `200` when processed, `422` if it still fails; after 5 failed attempts an event is parked as `dead`.
* **Replay All Failed Events:** `POST /api/workspace/connectors/:id/events/replay-failed` (`{"limit": 25}`, max 50; takes the most recent failed events and replays them oldest-first)
* **Event Detail (raw payload, company_admin only):** `GET /api/workspace/connectors/:id/events/:eventId`
* **One-click Payment Gateway Connect (Stripe / PayPal / Razorpay):** see section 11.1

---

## 8. Public Attribution & Tracking Engine APIs (`/v1`)
*Authenticated via Header: `Authorization: Bearer <API_KEY>` or `X-Api-Key: <API_KEY>`.*

### 8.1 Record Touch (Page View Tracking)
Called by the client-side JavaScript SDK on every page view or ad landing.
* **Method:** `POST`
* **Endpoint:** `/v1/touches`
* **Auth:** Publishable Key (Browser) or Secret Key
* **Request Body:**
  ```json
  {
    "visitorId": "uuid-generated-in-localstorage",
    "touchedAt": "2026-03-01T15:30:00.000Z",
    "source": "google",
    "medium": "cpc",
    "campaign": "summer_sale",
    "term": "running shoes",
    "content": "ad_variant_1",
    "referrer": "https://google.com",
    "landingPage": "https://example.com/shoes?utm_source=google&utm_medium=cpc",
    "pageTitle": "Shoes Collection | Acme",
    "gclid": "Cj0KCQjwp...",
    "fbclid": null,
    "ttclid": null,
    "msclkid": null,
    "fbc": null,
    "fbp": "_fbp.1.12345678",
    "ga": "_ga.1.87654321"
  }
  ```
* **Response `201 Created`:**
  ```json
  {
    "id": "touch-uuid",
    "touchId": "touch-uuid",
    "visitorId": "uuid-generated-in-localstorage",
    "visitorRecordId": "visitor-record-uuid",
    "siteId": "site-uuid",
    "channel": "paid_search",
    "touchedAt": "2026-03-01T15:30:00.000Z"
  }
  ```
  A deduplicated touch returns the existing `touchId` and `visitorRecordId` with HTTP `200`.

### 8.2 Identify Visitor
Links anonymous visitor ID to a customer's email or phone upon form submission or signin.
* **Method:** `POST`
* **Endpoint:** `/v1/identify`
* **Auth:** Publishable Key (from an allowed origin)
* **Request Body:**
  ```json
  {
    "visitorId": "uuid-generated-in-localstorage",
    "email": "customer@gmail.com",
    "phone": "+14155552671"
  }
  ```
* **Response `200 OK`:**
  ```json
  {
    "customerId": "cust-uuid",
    "visitorId": "uuid-generated-in-localstorage",
    "visitorRecordId": "visitor-record-uuid",
    "touchIds": ["touch-uuid"],
    "touchCount": 1,
    "isNew": false
  }
  ```

### 8.3 Create Checkout Session
Freezes the visitor's marketing touches into a snapshot token to be attached to checkout / payment session.
* **Method:** `POST`
* **Endpoint:** `/v1/checkout-sessions`
* **Auth:** Publishable Key (from an allowed origin)
* **Request Body:**
  ```json
  {
    "visitorId": "uuid-generated-in-localstorage",
    "expiresInMs": 7200000
  }
  ```
* **Response `201 Created`:**
  ```json
  {
    "checkoutSessionId": "checkout-session-uuid",
    "token": "cs_sec_999abc123...",
    "visitorId": "uuid-generated-in-localstorage",
    "visitorRecordId": "visitor-record-uuid",
    "touchIds": ["touch-uuid"],
    "touchCount": 1,
    "expiresAt": "2026-03-01T17:30:00.000Z"
  }
  ```

### 8.4 Ingest Order / Conversion
Ties an order to marketing touches across all 6 attribution models in one transaction.
* **Method:** `POST`
* **Endpoint:** `/v1/orders` *(Alias: `/v1/conversions`)*
* **Auth:** Publishable Key or Secret Key
* **Request Body:**
  ```json
  {
    "externalId": "order_12345",
    "orderedAt": "2026-03-01T15:45:00.000Z",
    "currency": "USD",
    "grossAmount": 150.00,
    "netAmount": 140.00,
    "discountAmount": 10.00,
    "taxAmount": 0.00,
    "checkoutToken": "cs_sec_999abc123...",
    "visitorId": "uuid-fallback",
    "email": "customer@gmail.com",
    "phone": "+14155552671",
    "locationId": "loc-uuid",
    "idempotencyKey": "order_12345",
    "items": [
      {
        "name": "Sneakers",
        "quantity": 1,
        "unitAmount": 140.00,
        "currency": "USD",
        "externalId": "prod_sneakers_9"
      }
    ]
  }
  ```
* **Response `201 Created`:**
  ```json
  {
    "id": "order-uuid",
    "orderId": "order-uuid",
    "externalId": "order_12345",
    "customerId": "cust-uuid",
    "visitorId": "uuid-generated-in-localstorage",
    "visitorRecordId": "visitor-record-uuid",
    "connectorId": "connector-uuid",
    "locationId": "location-uuid",
    "checkoutSessionId": "checkout-session-uuid",
    "touchIds": ["touch-uuid-1", "touch-uuid-2", "touch-uuid-3"],
    "orderItemIds": ["order-item-uuid"],
    "attributionCreditIds": ["attribution-credit-uuid"],
    "status": "paid",
    "matchMethod": "token",
    "isNewCustomer": true,
    "touchCount": 3,
    "currency": "USD"
  }
  ```

### 8.5 Update Order Status
* **Method:** `PATCH`
* **Endpoint:** `/v1/orders/:id`
* **Body:** `{"status": "cancelled"}`
* **Response:** Includes `id` / `orderId` and the updated `status`.

### 8.6 List Orders
* **Method:** `GET`
* **Endpoint:** `/v1/orders`
* **Query Parameters:** `status`, `locationId`, `from`, `to`, `page`, `limit`
* **Response `200 OK`:** Paginated list of orders.

### 8.7 Get Order Attribution Breakdown
Returns fractional credits for an order under each attribution model.
* **Method:** `GET`
* **Endpoint:** `/v1/orders/:id/attribution`
* **Response `200 OK`:**
  ```json
  {
    "orderId": "order-uuid",
    "externalId": "order_12345",
    "matchMethod": "token",
    "attribution": {
      "first_touch": [
        { "id": "credit-uuid", "attributionCreditId": "credit-uuid", "touchId": "touch-1", "share": 1.0, "amountMinorUnits": "14000", "currency": "USD" }
      ],
      "last_non_direct": [
        { "touchId": "touch-2", "share": 1.0, "amountMinorUnits": "14000", "currency": "USD" }
      ],
      "linear": [
        { "touchId": "touch-1", "share": 0.5, "amountMinorUnits": "7000", "currency": "USD" },
        { "touchId": "touch-2", "share": 0.5, "amountMinorUnits": "7000", "currency": "USD" }
      ],
      "time_decay": [ ... ],
      "position_based": [ ... ],
      "last_touch": [ ... ]
    }
  }
  ```
  Every attribution entry includes both `id` and `attributionCreditId` so a frontend can cross-check the individual credit record.

### 8.8 Bookings APIs
* **Create Booking:** `POST /v1/bookings`
  * **Body:**
    ```json
    {
      "externalId": "book_9876",
      "appointmentStartAt": "2026-03-05T14:00:00.000Z",
      "currency": "USD",
      "bookedValue": 85.00,
      "checkoutToken": "cs_sec_...",
      "visitorId": "...",
      "email": "customer@gmail.com",
      "serviceName": "Haircut & Styling",
      "appointmentEndAt": "2026-03-05T15:00:00.000Z",
      "locationId": "loc-uuid"
    }
    ```
  * **Response `201 Created`:** Includes `id` / `bookingId`, `customerId`, `visitorId`, `visitorRecordId`, `connectorId`, `locationId`, `checkoutSessionId`, `touchIds`, `statusHistoryId`, and `attributionCreditIds` alongside status and matching details.
* **Update Booking Status:** `PATCH /v1/bookings/:id`
  * **Body:** `{"status": "completed", "reason": "Service rendered"}`
  * *(Valid statuses: `scheduled`, `confirmed`, `completed`, `cancelled`, `rescheduled`, `no_show`)*
  * **Response:** Includes `id` / `bookingId`, `statusHistoryId`, and the updated `status`.
* **List Bookings:** `GET /v1/bookings` (`status`, `locationId`, `from`, `to`, `page`, `limit`)
* **List Upcoming Bookings:** `GET /v1/bookings/upcoming?days=7&locationId=...`

### 8.9 Refunds API
* **Create Refund:** `POST /v1/refunds`
  * **Body:**
    ```json
    {
      "orderId": "order-uuid",
      "amount": 50.00,
      "currency": "USD",
      "reason": "Customer return",
      "externalId": "re_99999"
    }
    ```
  * **Response `201 Created`:** Includes `id` / `refundId`, `orderId`, `externalOrderId`, `externalId`, and updated `orderStatus`, plus the refund amount and currency. A duplicate refund returns the existing refund and order IDs with HTTP `200`.
* **List Refunds:** `GET /v1/refunds` (secret key), `GET /api/workspace/refunds` (dashboard session), `GET /api/view/refunds/workspace/:workspaceId` (platform admin, support session)
  * **Query:** `from`, `to` (local days, by refund date), `tz`, `model` (for the order's source), `locationId`, `channel`, `orderId`, `search` (refund or order external id), `includeTest=true`, `page`/`limit` or `cursor`, `format=csv`.
  * **Response `200`:** `{ model, data: [{ id, externalId, refundedAt, amountMinorUnits, currency, reason, orderId, orderExternalId, orderedAt, orderNetMinorUnits, customerId, locationName, source, campaign }], pagination, totals: { refunds, amountMinorUnits } }`, newest first.

### 8.10 Customers & Attribution Journey APIs
* **Company customer list:** `GET /api/workspace/customers`
  * **Auth:** Cookie (`user_token`), `company_admin` or `company_viewer`
  * **Response:** Includes `email` for newly received addresses. Existing customers only have an email hash, so their email remains `null` until received again from a payment/booking source.
  * Customer source fields use the selected attribution model: `firstSource`, `firstCampaign`, `lastSource`, and `lastCampaign`.
  * Emails are encrypted at rest and are not returned by the API-key-authenticated `/v1/customers` endpoints.
* **Company customer journey:** `GET /api/workspace/customers/:id/journey` uses the same cookie auth and includes the customer's email when available.
* **List Customers:** `GET /v1/customers`
  * **Query:** `externalId`, `externalIdKey`, `page`, `limit`
* **Get Customer Journey:** `GET /v1/customers/:id/journey`
  * **Query:** `model` (default: `"last_non_direct"`)
  * **Response `200 OK`:** Complete multi-touch chronological journey:
    * `customer`: Customer profile and timestamps.
    * `touches`: Array of all page views, UTMs, and ad clicks across all devices.
    * `orders`: Array of all orders with attributed credit shares for this model.
    * `bookings`: Array of all bookings with attributed credit shares.
    * `refunds`: Associated refunds.

---

## 9. Analytics & Reporting APIs (`/v1/reports` & `/api/workspace/reports`)
*All report endpoints accept query parameters:*  
`from` (ISO date), `to` (ISO date), `model` (default: `last_non_direct`), `locationId` (optional), `tz` (default: `UTC`).  
Report endpoints accept either an authenticated company user session cookie (`user_token`) or a **secret API key** (`Authorization: Bearer sk_…`, `/v1/*` routes only); the workspace is derived from the session or key, never from the request. Publishable keys are rejected.

**Date semantics (all report and list endpoints):** `from`/`to` given as `YYYY-MM-DD` mean whole **local days** in `tz` (default: the workspace timezone), so `to` includes the entire last day and daylight-saving days (23/25 h) are handled. A full ISO timestamp is used as an exact instant. Without dates, reports cover the last 30 local days ending today; list endpoints stay unfiltered. Every report returns `period: { from, to, tz }`. Invalid dates/timezones return `400`. `GET /v1/orders` and `GET /v1/bookings` use the same rule, so a drill-down list always adds up to its report.

### 9.1 Executive Dashboard Overview (Elysium UI)
Tailored all-in-one endpoint returning the exact data structures rendered on the **Elysium Revenue Management Dashboard**:
* **Method:** `GET`
* **Endpoint:** `/api/workspace/dashboard` *(or `/v1/reports/dashboard`)*
* **Auth:** Cookie (`user_token`), `company_admin` or `company_viewer`
* **Response `200 OK`:**
  ```json
  {
    "period": { "from": "2026-09-14T00:00:00.000Z", "to": "2026-10-14T23:59:59.999Z" },
    "currency": "USD",
    "primaryRevenue": {
      "totalRevenue": "49849.40",
      "totalRevenueFormatted": "$49,849.40",
      "exclTax": "34894.58",
      "tax": "14954.82",
      "invoicesCount": 144,
      "description": "Company-wide revenue, all locations combined, across 144 invoices."
    },
    "kpis": {
      "newCustomers": { "value": 383, "label": "company-wide" },
      "returningCustomers": { "value": 74, "label": "company-wide" },
      "retention": { "percentage": 50.3, "detail": "1659 of 3297, all-time" },
      "trackedVisits": { "value": 2406, "label": "company-wide" }
    },
    "revenueCards": {
      "adAttributed": {
        "value": "6494.72",
        "formatted": "$6,494.72",
        "subtext": "Meta + Google + AWIN only"
      },
      "directOrganic": {
        "value": "46221.31",
        "formatted": "$46,221.31",
        "subtext": "walk-ins & untracked"
      },
      "unattributed": {
        "value": "0.00",
        "formatted": "$0.00",
        "subtext": "no conversion at all"
      },
      "refunded": {
        "value": "127.32",
        "formatted": "$-127.32",
        "subtext": "3 refunds · all locations"
      },
      "avgOrderValue": {
        "value": "64.65",
        "formatted": "$64.65",
        "changePercent": -18.1,
        "trend": "down",
        "subtext": "▼ 18.1% vs prior period"
      }
    },
    "revenueBySource": [
      { "source": "Google", "percentage": 95, "color": "#3b82f6", "revenue": "47356.93", "conversions": 91 },
      { "source": "META", "percentage": 3, "color": "#a855f7", "revenue": "1495.48", "conversions": 7 },
      { "source": "Direct", "percentage": 2, "color": "#22c55e", "revenue": "996.99", "conversions": 735 }
    ],
    "revenueByPlatform": [
      { "platform": "Direct", "badge": "Direct", "conversions": 735, "revenue": "47585.16", "color": "#22c55e" },
      { "platform": "Google", "badge": "Google", "conversions": 91, "revenue": "6542.63", "color": "#3b82f6" },
      { "platform": "AWIN", "badge": "AWIN", "conversions": 8, "revenue": "276.03", "color": "#71717a" },
      { "platform": "META", "badge": "META", "conversions": 7, "revenue": "296.03", "color": "#a855f7" }
    ]
  }
  ```

### 9.2 Summary Overview Report
* **Method:** `GET`
* **Endpoint:** `/v1/reports/summary` *(or `/api/workspace/reports/summary`)*
* **Response `200 OK`:**
  ```json
  {
    "period": { "from": "2026-02-01T00:00:00.000Z", "to": "2026-03-01T23:59:59.999Z" },
    "currency": "USD",
    "model": "last_non_direct",
    "revenue": {
      "grossMinorUnits": "12500000",
      "discountsMinorUnits": "500000",
      "refundsMinorUnits": "200000",
      "netMinorUnits": "11800000",
      "averageOrderValueMinorUnits": "11800"
    },
    "orders": {
      "total": 1000,
      "newCustomers": 650,
      "returningCustomers": 350
    },
    "attribution": {
      "attributedRevenueMinorUnits": "10500000",
      "coverageRate": 88.98
    },
    "bookings": {
      "total": 450,
      "scheduled": 380,
      "cancelled": 70,
      "bookedValueMinorUnits": "4500000",
      "cancellationRate": 15.56
    }
  }
  ```

### 9.2 Channels Breakdown Report
* **Method:** `GET`
* **Endpoint:** `/v1/reports/channels`
* **Response `200 OK`:**
  ```json
  {
    "period": { ... },
    "model": "last_non_direct",
    "data": [
      {
        "channel": "paid_search",
        "orders": 450,
        "netMinorUnits": "5400000",
        "newCustomers": 320,
        "returningCustomers": 130
      },
      {
        "channel": "paid_social",
        "orders": 300,
        "netMinorUnits": "3600000",
        "newCustomers": 210,
        "returningCustomers": 90
      },
      {
        "channel": "organic_search",
        "orders": 150,
        "netMinorUnits": "1800000",
        "newCustomers": 80,
        "returningCustomers": 70
      },
      {
        "channel": "direct_unknown",
        "orders": 100,
        "netMinorUnits": "1000000",
        "newCustomers": 40,
        "returningCustomers": 60
      }
    ]
  }
  ```

### 9.3 Campaigns Breakdown Report
* **Method:** `GET`
* **Endpoint:** `/v1/reports/campaigns`
* **Response `200 OK`:**
  ```json
  {
    "period": { ... },
    "model": "last_non_direct",
    "data": [
      {
        "channel": "paid_search",
        "campaign": "brand_exact_match",
        "orders": 250,
        "netMinorUnits": "3000000"
      }
    ]
  }
  ```

### 9.4 Locations Breakdown Report
* **Method:** `GET`
* **Endpoint:** `/v1/reports/locations`
* **Response `200 OK`:**
  ```json
  {
    "period": { ... },
    "data": [
      {
        "locationId": "loc-uuid-1",
        "locationName": "Downtown Store",
        "orders": 400,
        "netMinorUnits": "4800000",
        "newCustomers": 260,
        "returningCustomers": 140
      }
    ]
  }
  ```

### 9.5 Daily Trend Report
* **Method:** `GET`
* **Endpoint:** `/v1/reports/trend`
* **Response `200 OK`:**
  ```json
  {
    "period": { ... },
    "tz": "America/New_York",
    "data": [
      {
        "date": "2026-02-01",
        "orders": 35,
        "netMinorUnits": "420000",
        "newCustomers": 22
      }
    ]
  }
  ```

### 9.6 Customers Retention & Cohort Report
* **Method:** `GET`
* **Endpoint:** `/v1/reports/customers`
* **Response `200 OK`:**
  ```json
  {
    "period": { ... },
    "newCustomers": 650,
    "returningCustomers": 350,
    "totalCustomers": 2500,
    "repeatRate": 38.5
  }
  ```

---

## 10. Platform Admin APIs (`/api/platform-admin`)
*All routes require JWT Cookie with `role: "platform_admin"`.*

| Method | Endpoint | Description | Query / Body Params |
|---|---|---|---|
| `GET` | `/api/platform-admin/dashboard` | Overall platform KPIs & counts | None |
| `GET` | `/api/platform-admin/workspaces` | List all client workspaces | `status`, `page`, `limit` |
| `GET` | `/api/platform-admin/workspaces/:workspaceId` | Workspace detail & diagnostics | None |
| `GET` | `/api/platform-admin/workspaces/:workspaceId/dashboard` | View a company's executive dashboard | Query: `reason` (at least 5 characters), plus standard dashboard filters |
| `PATCH` | `/api/platform-admin/workspaces/:workspaceId/status` | Approve, suspend, or close workspace | Body: `{ status, reason }` |
| `PATCH` | `/api/platform-admin/workspaces/:workspaceId/settings` | Admin override workspace settings | Body: `{ reason, ...settings }` |
| `GET` | `/api/platform-admin/workspaces/:workspaceId/users` | List users of a specific workspace | None |
| `PATCH` | `/api/platform-admin/users/:userId` | Update user status or role | Body: `{ role, status, reason }` |
| `GET` | `/api/platform-admin/api-keys` | List all API keys across workspaces | `workspaceId`, `includeRevoked`, `page`, `limit` |
| `POST` | `/api/platform-admin/api-keys/:keyId/revoke` | Revoke any API key forcefully | Body: `{ reason }` |
| `GET` | `/api/platform-admin/connectors` | List all connectors platform-wide | `workspaceId`, `type`, `page`, `limit` |
| `PATCH` | `/api/platform-admin/connectors/:connectorId/status` | Change connector health status | Body: `{ status, reason }` |
| `GET` | `/api/platform-admin/webhooks` | List outbound webhooks platform-wide | `workspaceId`, `page`, `limit` |
| `PATCH` | `/api/platform-admin/webhooks/:webhookId` | Toggle webhook active state | Body: `{ isActive, reason }` |

*Note: All platform admin write actions require `reason` with at least 5 characters for auditing.*
Viewing a company's dashboard requires a `reason` query parameter of at least 5 characters and is recorded in the audit log. The response uses the same metrics and filters as the company dashboard endpoint.

---

## 11. Inbound Webhook Integrations (`/api/connectors`)

Configured externally using the webhook URL generated by `POST /api/workspace/connectors`. Recognized top-level secret fields (including `webhookSecret`, `sharedSecret`, `clientId`, and `clientSecret`) in new or updated connector configs are encrypted at rest; re-save legacy connector configuration to encrypt secrets that were previously stored in plaintext. Other mapping/settings fields remain in `config`. Do not send provider API credentials from a browser.

* `POST /api/connectors/stripe/webhook?connectorId=<id>` (Header: `stripe-signature`)
* `POST /api/connectors/shopify/webhook?connectorId=<id>` (Header: `x-shopify-hmac-sha256`)
* `POST /api/connectors/zenoti/webhook?connectorId=<id>` (Header: `x-zenoti-signature`)
* `POST /api/connectors/razorpay/webhook?connectorId=<id>` (Header: `x-razorpay-signature`)
* `POST /api/connectors/paypal/webhook?connectorId=<id>` (verified through PayPal's webhook verification API)
* `POST /api/connectors/woocommerce/webhook?connectorId=<id>` (configurable HMAC and field mapping)
* `POST /api/connectors/square/webhook?connectorId=<id>` (configurable HMAC and field mapping)
* `POST /api/connectors/generic/webhook?connectorId=<id>` (configurable HMAC and field mapping)

### 11.1 One-click payment gateway connect (Stripe, PayPal, Razorpay)

All endpoints below require the `company_admin` role (cookie auth) because they handle gateway credentials. Never log or persist these request bodies on the frontend.

**Server prerequisites:** `APP_API_URL` must be a public **https** URL of this API (gateways deliver webhooks only to public HTTPS endpoints). Set a dedicated `ENCRYPTION_KEY` (see `.env.example`).

| Gateway | Mode | What happens on "Connect" |
|---|---|---|
| Stripe | **auto** | Backend calls Stripe to create the webhook endpoint, stores its signing secret (encrypted). The API key is used once and **not stored**. |
| PayPal | **auto** | Backend creates the webhook through PayPal's Notifications API. Client ID/secret are stored encrypted (needed to verify each event). |
| Razorpay | **manual** | Razorpay only allows API webhook creation for partner accounts. Backend generates the URL + signing secret and returns them **once**; the merchant pastes them into the Razorpay dashboard. |

Webhook URLs created by the platform look like `https://<APP_API_URL>/api/connectors/<type>/webhook/<connectorId>`. The legacy `?connectorId=` form keeps working.

**`GET /api/workspace/connectors/gateways`** — catalog that drives the Connect modals.
```json
{ "ready": true, "problem": null, "webhookBase": "https://api.example.com",
  "data": [ { "type": "stripe", "label": "Stripe", "mode": "auto", "events": ["payment_intent.succeeded", "..."],
              "fields": [ { "name": "secretKey", "label": "...", "type": "password", "required": true, "help": "..." } ], "notes": ["..."] } ] }
```
If `ready` is `false`, show `problem` (e.g. APP_API_URL is localhost/http) instead of the form.

**`POST /api/workspace/connectors/connect`**
```json
{ "type": "stripe",   "name": "Main Stripe (optional)", "credentials": { "secretKey": "sk_live_… or rk_live_…" } }
{ "type": "paypal",   "credentials": { "environment": "live", "clientId": "…", "clientSecret": "…" } }
{ "type": "razorpay" }
```
`201` →
```json
{ "id": "…", "type": "stripe", "name": "Stripe", "status": "pending",
  "webhookUrl": "https://api.example.com/api/connectors/stripe/webhook/<id>",
  "connected": true, "mode": "auto", "message": "…",
  "connection": { "gateway": "stripe", "mode": "auto", "environment": "live", "accountId": "acct_…", "businessName": "…",
                  "enabledEvents": ["…"], "connectedAt": "…", "awaitingFirstEvent": true },
  "setup": null }
```
For Razorpay, `setup` is `{ "webhookUrl", "webhookSecret", "events", "optionalEvents", "steps": [...] }` — **the secret is shown only in this response** (and again after reconnect/rotate). The connector status is `pending` until the first verified event arrives, then `healthy`.

Errors: `400 validation_error | invalid_credentials`, `409 already_connected` (same Stripe account / PayPal app already connected in this workspace), `422 rejected` (gateway refused, message included), `502 unavailable` (gateway unreachable/timeout). If anything fails after the webhook was created at the gateway, it is deleted again (no orphans).

**`GET /api/workspace/connectors/:id`** — detail (`webhookUrl`, `connection`, `requiredEvents`, `hasSigningSecret`). Secrets are never returned.

**`POST /api/workspace/connectors/:id/verify`** — health checks → `{ ok, status, awaitingFirstEvent, lastEventAt, errorCount, checks: [{ name, ok, detail }] }`. PayPal also checks the remote webhook exists, its URL and subscribed events. For Stripe send `{ "credentials": { "secretKey": "…" } }` to also check the remote endpoint (optional; the key is not stored).

**`POST /api/workspace/connectors/:id/reconnect`** — same body as connect. Creates a new webhook with the new credentials (Stripe/PayPal) or rotates the signing secret (Razorpay, returns `setup` again), removes the previous remote webhook (`previousWebhookRemoved`), sets status back to `pending`. This is also how a disconnected connector is re-enabled.

**`POST /api/workspace/connectors/:id/disconnect`** — body optional: `{ "credentials": { "secretKey": "…" }, "force": false }`.
The connector is **disabled, not deleted** (orders, events and audit history stay), stored secrets are wiped, and any further events are acknowledged with `200 { ignored: "connector_disabled" }` and dropped. The remote webhook is deleted where possible (PayPal automatically; Stripe only if the key is supplied again, since it is not stored). Response includes `remoteWebhook: { removed, reason }` and `manualSteps: []` — show these when the webhook must be removed by hand. If the gateway call fails you get `502` with `canForce: true`; resend with `force: true` to disconnect anyway.

**Connector list** (`GET /api/workspace/connectors`) now also returns `webhookUrl` and a `connection` summary per connector.

**Handled gateway events**

| Gateway | Orders | Refunds |
|---|---|---|
| Stripe | `payment_intent.succeeded`, `checkout.session.completed`, `checkout.session.async_payment_succeeded` | `charge.refunded` (all refunds on the charge, or the delta when the API version omits the refund list), `charge.refund.updated` |
| PayPal | `PAYMENT.CAPTURE.COMPLETED` | `PAYMENT.CAPTURE.REFUNDED` |
| Razorpay | `payment.captured`, `order.paid` | `refund.processed` |

A refund that arrives before its order fails with a clear error, is kept as a `failed` raw event and can be replayed once the order exists.

### 11.2 Customer merge

`POST /api/workspace/customers/merge` (company_admin) — body `{ "sourceId", "targetId" }`.
Moves the source's visitors/touches, orders and bookings to the target, carries over identifiers the target lacks (email/phone hash, external IDs; the target wins on conflicts), keeps the source as a tombstone (`mergedIntoId`), and **recomputes new-vs-returning** on the combined order history in one transaction. Returns `{ targetId, sourceId, moved: { orders, bookings, visitors }, newVsReturningFlagsChanged, firstPurchaseAt, lastPurchaseAt }`. Errors: `400` (same id / missing), `404` (not in your workspace), `409 already_merged | target_merged`. A merge does not re-run attribution credit for past orders.

"Paid" for new-vs-returning means `paid`, `partially_refunded` or `refunded` (an order that was later refunded was still a paid order); `pending` and `voided` never count.

### 11.3 Platform-admin support sessions

Platform admins can view a company's data (`/api/view/*`, `/api/platform-admin/workspaces/:id/dashboard`) only inside a **support session**:

* `POST /api/platform-admin/support-sessions` — `{ "workspaceId", "reason" (10–500 chars, shown to the company), "durationMinutes" (1–120, default 30), "maskPii" (default true) }` → `201` with the session `id`.
* Send `X-Support-Session: <id>` on every `/api/view/*` request. Without it: `403 support_session_required`; wrong admin/workspace: `403 support_session_invalid`; `403 support_session_ended | support_session_expired`.
* `POST /api/platform-admin/support-sessions/:id/end` and `GET /api/platform-admin/support-sessions` (own sessions).
* Customer emails are omitted while `maskPii` is true.
* Companies see every session with `GET /api/workspace/support-access` (supportAgent, reason, maskPii, startedAt, expiresAt, endedAt).
* Every session start/end and every data request is written through the audit helper (`services/audit.js`).
* Migration aid: `SUPPORT_ACCESS_REQUIRED=false` disables the session requirement (PII stays masked). Leave it unset in production.

### 11.4 Audit log availability

Audit entries go through `services/audit.js`. When the schema has an `AuditLog` model they are stored and `GET /api/workspace/audit-log` lists them; when it does not, entries are emitted as one structured JSON line (`{"audit":true,...}`) on the server log, operations keep working, and `GET /api/workspace/audit-log` returns `{ "data": [], "available": false }`.

### Checkout token handoff and connector setup

The ecommerce server must attach the checkout-session token to the payment it creates. The browser should not send provider credentials or treat the token as a payment secret.

* **Stripe:** use `checkout.session.completed` (and `checkout.session.async_payment_succeeded` for delayed payment methods) and store the token in the Checkout Session `metadata.attribution_token` (or `metadata.checkout_token`). If also consuming `payment_intent.succeeded`, copy the same token to `payment_intent_data.metadata.attribution_token`. Configure the Stripe webhook signing secret (`whsec_...`) as connector `config.webhookSecret`. When both events are enabled they resolve to the same PaymentIntent ID for idempotent order ingestion.
* **Razorpay:** include the checkout-session token in the Razorpay order notes, preferably as `notes: { attribution_token: token }`. The webhook also accepts `checkout_token` and `sessionToken`. Configure its webhook signing secret as `config.webhookSecret`.
* **Shopify:** include the token as an order/cart attribute named `attribution_token`; configure the Shopify app shared secret as `config.sharedSecret`.
* **Zenoti:** if using the direct webhook route, configure `config.webhookSecret` and have the sender include the HMAC-SHA256 hex digest of the exact request body in `x-zenoti-signature`.
* **PayPal:** set the token as the purchase unit `custom_id`. Configure `clientId`, `clientSecret`, and the webhook's `webhookId`; set `paypalEnvironment` to `live` for production (the default is PayPal sandbox). The handler verifies each event with PayPal before ingestion.
* **WooCommerce and Square:** use their generated type-specific URL and configure `config.webhookSecret`, `config.signatureHeader`, `config.signatureEncoding`, `config.fieldMap`, and `config.orderEventTypes`. WooCommerce's signature is Base64; configure `signatureEncoding: "base64"` and `eventTypeHeader: "x-wc-webhook-topic"`. Square signs the notification URL concatenated with the raw body; configure `signatureEncoding: "base64"`, `signatureHeader: "x-square-hmacsha256-signature"`, `signatureIncludeUrl: true`, and `notificationUrl` to the exact URL registered with Square. Map the token's payload path to `fieldMap.checkoutToken`.
* **Generic:** same HMAC/field-mapping mechanism, using the provider-specific signature header and payload paths.

Example field mapping (paths refer to the provider's JSON payload):

```json
{
  "webhookSecret": "provider-webhook-secret",
  "signatureHeader": "x-webhook-signature",
  "signatureEncoding": "hex",
  "eventTypeField": "type",
  "orderEventTypes": ["order.paid"],
  "fieldMap": {
    "externalId": "data.order.id",
    "orderedAt": "data.order.created_at",
    "currency": "data.order.currency",
    "grossAmount": "data.order.total",
    "netAmount": "data.order.subtotal",
    "email": "data.customer.email",
    "checkoutToken": "data.order.metadata.attribution_token"
  }
}
```

The `generic`/WooCommerce/Square handler requires an HMAC secret and rejects invalid signatures. PayPal uses its provider verification API. Provider-specific webhook signing formats that are not HMAC-compatible should use a native handler or a trusted ecommerce-server relay that verifies the provider signature before forwarding a configured HMAC-signed canonical event.

After an event is ingested, successful webhook responses include the created or matched `order`, `booking`, or `refund` response (including its record IDs). Do not rely on a webhook response to confirm that a payment itself succeeded; the provider's event is the source of that status.

---

## 12. Quick Frontend Integration Cheat Sheet

### Common Axios Client Example
```javascript
import axios from 'axios';

// 1. Dashboard API Client (Cookie Auth)
export const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000',
  withCredentials: true, // MANDATORY FOR COOKIE SESSION
  headers: {
    'Content-Type': 'application/json',
  },
});

// 2. Public / SDK API Client (API Key Auth)
export const v1Client = (apiKey) => axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  },
});
```
