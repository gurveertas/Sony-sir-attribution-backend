# Alignment with "Attribution Platform: Product Scope" (Wink Attribution v1.0)

This file maps the scope document to the code in this backend and in the frontend
(`AtributionSystemFrontend-main`). It covers the v1 scope: build phases 0–4. Items the document marks
"Later" and phase 5 (more connectors, sending conversions back to ad platforms, warehouse export,
SSO, other languages) are not built.

## Before you deploy: three required steps

1. **Regenerate the contract and migrate the database.** `src/prisma/contract.prisma` changed. The
   generated `contract.json` / `contract.d.ts` in the repo are the old ones. The npm registry was not
   reachable while this was built, so the Prisma CLI could not run. Always regenerate the contract
   (the app reads it at runtime), then migrate the database **one** of two ways:
   ```bash
   npm ci
   npx prisma contract emit            # (= npm run build, also run by the Dockerfile)

   # Option A: Prisma migration (keeps Prisma's migration history in step)
   npx prisma migration plan           # writes migrations/app/<timestamp>_.../ (check: npx prisma migration --help)
   npx prisma migration apply

   # Option B: the ready-made SQL (when you cannot run the Prisma planner against the database)
   psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 -1 -f migrations/manual/20261026_v1_scope.sql
   ```
   `migrations/manual/20261026_v1_scope.sql` is generated from `contract.prisma`. It was run against
   PostgreSQL 16 on a database built from the existing migrations (`migrations/app/*`), then run a
   second time to confirm it changes nothing. Every statement is guarded (`IF NOT EXISTS`), so it is
   safe on a database that already has some of the tables. Use A or B, not both: after B, Prisma's
   migration history does not know the changes. Check whether your Prisma version can record the
   current contract as applied (`npx prisma db --help`) before you plan migrations with Prisma again.
   Every change is additive: new tables, new nullable columns or columns with defaults, and wider
   enum value lists. No existing column is dropped or renamed, so it is safe on a live database.
   Until you migrate, the optional tables (audit log, idempotency keys, webhook deliveries, rollups,
   ad spend, FX, background jobs) are skipped where the code can do without them.
   `tests/audit_optional.test.js` skips one test with a message while `contract.json` is stale.
2. **Set the new environment variables** (see `.env.example`). In production set `FRONTEND_URL` and
   `IDENTITY_HASH_KEY`, and set `IDENTITY_HASH_KEY` before real data arrives.
3. **Platform admins need two-factor login.** With `REQUIRE_PLATFORM_ADMIN_2FA=true` (the default), a
   platform admin's first sign-in after the upgrade goes to `/setup-2fa`, and every other API call is
   refused until 2FA is set up.

## Schema changes (contract.prisma)

* **Workspace:** `pending` status (approval queue), `taxIncludedInRevenue`, `rollupsBuiltAt`,
  `rollupsDataToken` / `rollupsBuiltToken` (shared rollup freshness).
* **User:** `twoFactorSecretEnc` (encrypted TOTP secret), `passwordChangedAt` (sessions issued before
  a password change are refused).
* **Touch:** `isTest`, plus indexes on `(workspaceId, gclid)` and `(workspaceId, fbclid)`.
* **Customer:** `erasedAt`. **CheckoutSession:** `consumedBookingId`.
* **Order / Booking:** `attributionReason`, `isTest`, plus `Order.bookingId` (invoice → booking link)
  and `Booking.bookedAt`.
* **AttributionCredit:** `channel`, `campaign`, `reasonCode` (credits keep their source even after an
  erasure; unmatched credits say why), index `(workspaceId, model)`.
* **RawEvent:** `attempts`, `nextAttemptAt`, `idempotencyKey`, `isTest` (the event queue).
* **MatchMethod:** new `visitor_id` value.
* **New models:** `AuditLog`, `IdempotencyKey`, `WebhookDelivery`, `AdAccount`, `AdSpend`, `FxRate`,
  `DailyRollup`, `DailyAttributionRollup`, `RollupDirtyDay` (D8), `BackgroundJob` (durable jobs).

## Module by module (section 4)

| Scope | Where | Notes |
|---|---|---|
| 4.1 Onboarding & company management | `authController` (register, verify, resend, approval), `services/onboarding.js` (setup checklist, test events, live feed), `workspaceController` (settings, locations, invites, team, close account) | New companies verify their email; with `REQUIRE_WORKSPACE_APPROVAL` they wait for approval. Live keys only work on a verified domain. Frontend: Settings → Setup checklist, Team (invite with role + location limits), SignUp (website, week start). |
| 4.2 Site SDK | `public/sdk/v1.js` (served at `/sdk/v1.js`), `trackingController` | `Wink.identify`, `getCheckoutToken`, `decorateLinks`, `consent`, `track`; queue + retry; consent modes; internal navigation is not a new touch; Shopify/Woo token injection. ~3.7 KB gzipped. |
| 4.3 Public API | `routes/v1Routes.js`, `middlewares/apiWrite.js` | Every write accepts `Idempotency-Key` and `Prefer: respond-async` (202 + queued). Errors are `{ message, code }`. Lists paginate; reports export with `format=csv`. Secret vs publishable keys, test vs live, rotation with a grace period. |
| 4.4 Connectors | `connectorController`, `connectorProcessors` | Acknowledge first, process async from the raw-event queue. Zenoti: invoice → booking link, cancellations, guest merge. Shopify amounts corrected. Per-request connector context (AsyncLocalStorage), so companies never share state. |
| 4.5 Identity resolution | `services/identityService.js` | Normalised email/phone, keyed HMAC hashing with legacy SHA-256 fallback, visitor ↔ customer linking, merges re-attribute. |
| 4.6 Attribution engine | `services/attributionEngine.js`, `services/ingestion.js` | Match order: token → visitor id → email/phone → click id → none (with reason code). Models: first, last, last non-direct, linear, position-based, time-decay. Same-visit collapse; a later direct visit never replaces a paid click; per-channel lookback overrides. Credits are exact (largest remainder, they always add up). Booking credit carries to its invoice. |
| 4.7 Metrics engine | `services/metrics.js`, `services/rollups.js`, `reportsController` | All section-6 metrics, company-local days (DST safe), previous-period comparison, alerts. D8 rollups. Freshness is stored in the database, so every API instance agrees: each write records its local days and changes a token before the API answers, and reports read rollups only when the rollups were built from that token. Otherwise they compute live, so a report never misses a write the API has already confirmed. |
| 4.8 Ad spend & CAC | `services/adSpend.js`, `services/adPlatforms.js` | CSV upload works now. Meta and Google Ads OAuth + daily sync are written against the public APIs but were **not tested against live accounts**. |
| 4.9 Platform admin | `platformToolsController`, `platformAdminController`, support sessions | Health page (events/min, latency, queue, dead letters, failing integrations), approvals, company list stats, replay, re-run, rebuild, key rotation, data deletion. Each needs a reason and is audited. 2FA is required. |
| 4.10 Security & privacy | `services/tenantDb.js`, `middlewares/protectRoute.js`, `services/privacy.js` | Tenant-scoped data layer. Login throttling + lockout, password policy, no account enumeration, TOTP 2FA, sessions revoked on password change. Customer export/erase, retention job, company purge. Errors never log request bodies or personal data. |
| 4.11 Time, currency & language | `utils/money.js`, `services/fx.js` | Currency-aware minor units (0/2/3 decimals), FX snapshot stored on each order, daily FX table (platform admin upload), tax included/excluded setting, week start. English only (other languages are "Later"). |
| 4.12 Reliability & operations | `services/eventQueue.js`, `services/jobs.js`, `services/workers.js`, `/health` | Inbound events: retries with backoff, dead-letter after 8 attempts, replay. Background jobs (re-runs, rebuilds, refreshes, ad spend syncs) are stored in `BackgroundJob`. A job a stopped or crashed instance leaves behind is resumed by any instance within about 5 minutes (stale lock, conditional claim). Failures retry with backoff and stop after 5 attempts, and platform health shows them with a Retry button. Outbound webhooks are signed (`t=…,v1=HMAC(t.body)`), logged and retried. Health check includes the database. |

## Dashboard screens (section 5): frontend

| Screen | Route (company · view-as under `/super/workspaces/:id/view/…`) |
|---|---|
| 5.1 Overview | `/` |
| 5.2 Channels and campaigns | `/channels`, `/campaigns` |
| 5.3 Customer journeys | `/journeys` (+ per-customer timeline in Customers) |
| 5.4 Orders and transactions | `/transactions` (filters in the URL, order detail with credits per model and refunds), `/refunds` (every refund on its own date, with its order and that order's source; CSV) |
| 5.5 Customers | `/customers` (sort, search, sources, merge) |
| 5.6 Bookings and upcoming | `/bookings` |
| 5.7 Locations | `/locations` |
| 5.8 Ad spend and CAC | `/ad-spend` |
| 5.9 Integrations and data quality | `/integrations` |
| 5.10 Settings | `/settings` (company, channel rules, locations, webhooks, audit log, privacy, 2FA, API keys, support access), `/team` |
| Platform admin | `/super`, `/super/health`, `/super/workspaces` (approve, stats), workspace detail (support tools), `/super/audit-log`, `/super/fx-rates` |
| Signed-out pages | `/signin` (+2FA step), `/signup`, `/forgot-password`, `/reset-password`, `/verify-user`, `/accept-invite`, `/setup-2fa` |

Every page shows the company's timezone and currency, its data freshness, and a CSV export.

## Acceptance criteria (section 9)

All ten are automated. Run `npm test`: 148 pass, 1 skipped (stale `contract.json`, see above).

| # | Test |
|---|---|
| 1–7, 9, 10 | `tests/acceptance.test.js` (one test per criterion, plus token, fallback, booking, FX, rollup, rounding and consent tests) |
| 8 | `tests/support.test.js` (support sessions are written to the company's audit log) |
| Security / platform | `tests/security_platform.test.js` (lockout, 2FA, reset, idempotency, async writes, signed webhooks, erasure, key rotation, ad spend, audited deletion) |
| Durability | `tests/durability.test.js` (jobs stored and resumed after a stopped instance, one claimer only, heartbeat, retry then dead; rollup freshness shared through the database; refunds list) |

## Known limits and open decisions

* **Contract and migration:** they must be generated or applied (step 1 above). The SQL migration was
  run against a real PostgreSQL 16. The application code was tested with the in-memory fake database,
  not with the real Prisma runtime, because its packages could not be installed here.
* **Meta / Google Ads APIs:** they have not been run against live accounts. CSV upload is the tested
  path. This needs app credentials and an ad account.
* **Zenoti:** the booking widget must pass the checkout token through. Check this with a real booking
  before relying on token matches for Zenoti. Email/phone matching works regardless.
* **Frontend build:** the frontend was type-checked against stubbed dependencies because the npm
  registry was not reachable. Run `npm ci && npm run build && npx oxlint` once to confirm.
* **Resuming jobs** waits up to about 5 minutes after a crash (the lock timeout), and a resumed job
  may run twice. Every job type is idempotent, so a second run is harmless.
