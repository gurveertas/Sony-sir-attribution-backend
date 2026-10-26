-- Wink Attribution: v1 product-scope schema changes (generated from src/prisma/contract.prisma).
-- Use EITHER this file OR the Prisma migration (npx prisma contract emit && npx prisma migration plan/apply),
-- not both. Every statement is idempotent (IF NOT EXISTS / guarded), so re-running is safe, and every
-- change is additive: nothing is dropped or renamed except enum CHECK constraints, which are replaced
-- by a wider list of allowed values.
-- Run in one transaction:  psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 -1 -f this-file.sql

-- Workspace
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "taxIncludedInRevenue" bool DEFAULT false NOT NULL;
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "rollupsBuiltAt" timestamptz;
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "rollupsDataToken" text;
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "rollupsBuiltToken" text;
-- WorkspaceStatus: now also allows pending
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT con.conname FROM pg_constraint con
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
           WHERE con.conrelid = '"public"."Workspace"'::regclass AND con.contype = 'c' AND a.attname = 'status'
  LOOP
    EXECUTE format('ALTER TABLE "public"."Workspace" DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE "public"."Workspace" ADD CONSTRAINT "Workspace_status_check_v1" CHECK ("status" IN ('pending', 'active', 'suspended', 'closed'));
END $$;

-- User
ALTER TABLE "public"."User" ADD COLUMN IF NOT EXISTS "twoFactorSecretEnc" bytea;
ALTER TABLE "public"."User" ADD COLUMN IF NOT EXISTS "passwordChangedAt" timestamptz;

-- Touch
ALTER TABLE "public"."Touch" ADD COLUMN IF NOT EXISTS "isTest" bool DEFAULT false NOT NULL;

-- Customer
ALTER TABLE "public"."Customer" ADD COLUMN IF NOT EXISTS "erasedAt" timestamptz;

-- CheckoutSession
ALTER TABLE "public"."CheckoutSession" ADD COLUMN IF NOT EXISTS "consumedBookingId" text;

-- Order
ALTER TABLE "public"."Order" ADD COLUMN IF NOT EXISTS "bookingId" text;
ALTER TABLE "public"."Order" ADD COLUMN IF NOT EXISTS "attributionReason" text;
ALTER TABLE "public"."Order" ADD COLUMN IF NOT EXISTS "isTest" bool DEFAULT false NOT NULL;
-- MatchMethod: now also allows visitor_id
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT con.conname FROM pg_constraint con
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
           WHERE con.conrelid = '"public"."Order"'::regclass AND con.contype = 'c' AND a.attname = 'matchMethod'
  LOOP
    EXECUTE format('ALTER TABLE "public"."Order" DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE "public"."Order" ADD CONSTRAINT "Order_matchMethod_check_v1" CHECK ("matchMethod" IN ('token', 'visitor_id', 'click_id', 'email', 'phone', 'none'));
END $$;

-- Booking
ALTER TABLE "public"."Booking" ADD COLUMN IF NOT EXISTS "bookedAt" timestamptz;
ALTER TABLE "public"."Booking" ADD COLUMN IF NOT EXISTS "attributionReason" text;
ALTER TABLE "public"."Booking" ADD COLUMN IF NOT EXISTS "isTest" bool DEFAULT false NOT NULL;
-- MatchMethod: now also allows visitor_id
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT con.conname FROM pg_constraint con
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
           WHERE con.conrelid = '"public"."Booking"'::regclass AND con.contype = 'c' AND a.attname = 'matchMethod'
  LOOP
    EXECUTE format('ALTER TABLE "public"."Booking" DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE "public"."Booking" ADD CONSTRAINT "Booking_matchMethod_check_v1" CHECK ("matchMethod" IN ('token', 'visitor_id', 'click_id', 'email', 'phone', 'none'));
END $$;

-- AttributionCredit
ALTER TABLE "public"."AttributionCredit" ADD COLUMN IF NOT EXISTS "channel" text;
ALTER TABLE "public"."AttributionCredit" ADD COLUMN IF NOT EXISTS "campaign" text;
ALTER TABLE "public"."AttributionCredit" ADD COLUMN IF NOT EXISTS "reasonCode" text;

-- RawEvent
ALTER TABLE "public"."RawEvent" ADD COLUMN IF NOT EXISTS "attempts" int4 DEFAULT 0 NOT NULL;
ALTER TABLE "public"."RawEvent" ADD COLUMN IF NOT EXISTS "nextAttemptAt" timestamptz;
ALTER TABLE "public"."RawEvent" ADD COLUMN IF NOT EXISTS "idempotencyKey" text;
ALTER TABLE "public"."RawEvent" ADD COLUMN IF NOT EXISTS "isTest" bool DEFAULT false NOT NULL;

-- AuditLog (exists in some databases from the baseline migration)
CREATE TABLE IF NOT EXISTS "public"."AuditLog" (
  "id" text NOT NULL,
  "workspaceId" text,
  "actorType" text NOT NULL,
  "actorUserId" text,
  "action" text NOT NULL,
  "targetType" text,
  "targetId" text,
  "reason" text,
  "metadata" json,
  "ip" text,
  "userAgent" text,
  "createdAt" timestamptz DEFAULT (now()) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "AuditLog_actorType_check_v1" CHECK ("actorType" IN ('user', 'platform_admin', 'api_key', 'system'))
);
ALTER TABLE "public"."AuditLog" ADD COLUMN IF NOT EXISTS "workspaceId" text;
-- "AuditLog"."actorType" is NOT NULL without default: created with the table above only
ALTER TABLE "public"."AuditLog" ADD COLUMN IF NOT EXISTS "actorUserId" text;
-- "AuditLog"."action" is NOT NULL without default: created with the table above only
ALTER TABLE "public"."AuditLog" ADD COLUMN IF NOT EXISTS "targetType" text;
ALTER TABLE "public"."AuditLog" ADD COLUMN IF NOT EXISTS "targetId" text;
ALTER TABLE "public"."AuditLog" ADD COLUMN IF NOT EXISTS "reason" text;
ALTER TABLE "public"."AuditLog" ADD COLUMN IF NOT EXISTS "metadata" json;
ALTER TABLE "public"."AuditLog" ADD COLUMN IF NOT EXISTS "ip" text;
ALTER TABLE "public"."AuditLog" ADD COLUMN IF NOT EXISTS "userAgent" text;
ALTER TABLE "public"."AuditLog" ADD COLUMN IF NOT EXISTS "createdAt" timestamptz DEFAULT (now()) NOT NULL;

-- IdempotencyKey (new table)
CREATE TABLE IF NOT EXISTS "public"."IdempotencyKey" (
  "id" text NOT NULL,
  "workspaceId" text NOT NULL,
  "key" text NOT NULL,
  "route" text NOT NULL,
  "requestHash" text NOT NULL,
  "statusCode" int4 NOT NULL,
  "responseBody" json NOT NULL,
  "createdAt" timestamptz DEFAULT (now()) NOT NULL,
  PRIMARY KEY ("id")
);

-- WebhookDelivery (new table)
CREATE TABLE IF NOT EXISTS "public"."WebhookDelivery" (
  "id" text NOT NULL,
  "workspaceId" text NOT NULL,
  "endpointId" text NOT NULL,
  "eventId" text NOT NULL,
  "eventType" text NOT NULL,
  "payload" json NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" int4 DEFAULT 0 NOT NULL,
  "responseStatus" int4,
  "error" text,
  "nextAttemptAt" timestamptz,
  "deliveredAt" timestamptz,
  "createdAt" timestamptz DEFAULT (now()) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "WebhookDelivery_status_check_v1" CHECK ("status" IN ('pending', 'succeeded', 'failed'))
);

-- AdAccount (new table)
CREATE TABLE IF NOT EXISTS "public"."AdAccount" (
  "id" text NOT NULL,
  "workspaceId" text NOT NULL,
  "platform" text NOT NULL,
  "externalAccountId" text NOT NULL,
  "name" text NOT NULL,
  "timezone" text,
  "currency" character varying(3),
  "status" text DEFAULT 'pending' NOT NULL,
  "credentialsEnc" bytea,
  "lastSyncedAt" timestamptz,
  "lastError" text,
  "createdAt" timestamptz DEFAULT (now()) NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "AdAccount_platform_check_v1" CHECK ("platform" IN ('meta', 'google', 'other')),
  CONSTRAINT "AdAccount_status_check_v1" CHECK ("status" IN ('pending', 'healthy', 'failing', 'disabled'))
);

-- AdSpend (new table)
CREATE TABLE IF NOT EXISTS "public"."AdSpend" (
  "id" text NOT NULL,
  "workspaceId" text NOT NULL,
  "adAccountId" text,
  "locationId" text,
  "platform" text NOT NULL,
  "channel" text NOT NULL,
  "date" character varying(10) NOT NULL,
  "campaignId" text,
  "campaignName" text NOT NULL,
  "adSetName" text,
  "adName" text,
  "spendMinorUnits" int8 NOT NULL,
  "currency" character varying(3) NOT NULL,
  "impressions" int4 DEFAULT 0 NOT NULL,
  "clicks" int4 DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'api' NOT NULL,
  "dedupeKey" text NOT NULL,
  "createdAt" timestamptz DEFAULT (now()) NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "AdSpend_platform_check_v1" CHECK ("platform" IN ('meta', 'google', 'other'))
);

-- FxRate (new table)
CREATE TABLE IF NOT EXISTS "public"."FxRate" (
  "id" text NOT NULL,
  "date" character varying(10) NOT NULL,
  "base" character varying(3) NOT NULL,
  "quote" character varying(3) NOT NULL,
  "rate" numeric NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "createdAt" timestamptz DEFAULT (now()) NOT NULL,
  PRIMARY KEY ("id")
);

-- DailyRollup (new table)
CREATE TABLE IF NOT EXISTS "public"."DailyRollup" (
  "id" text NOT NULL,
  "workspaceId" text NOT NULL,
  "day" character varying(10) NOT NULL,
  "locationId" text,
  "isNewCustomer" bool NOT NULL,
  "orders" int4 DEFAULT 0 NOT NULL,
  "grossMinorUnits" int8 DEFAULT '0'::int8 NOT NULL,
  "discountMinorUnits" int8 DEFAULT '0'::int8 NOT NULL,
  "taxMinorUnits" int8 DEFAULT '0'::int8 NOT NULL,
  "refundMinorUnits" int8 DEFAULT '0'::int8 NOT NULL,
  "matchedNetMinorUnits" int8 DEFAULT '0'::int8 NOT NULL,
  "bookingsCreated" int4 DEFAULT 0 NOT NULL,
  "bookedValueMinorUnits" int8 DEFAULT '0'::int8 NOT NULL,
  "currency" character varying(3) NOT NULL,
  "builtAt" timestamptz DEFAULT (now()) NOT NULL,
  PRIMARY KEY ("id")
);

-- RollupDirtyDay (new table)
CREATE TABLE IF NOT EXISTS "public"."RollupDirtyDay" (
  "id" text NOT NULL,
  "workspaceId" text NOT NULL,
  "day" character varying(10) NOT NULL,
  "createdAt" timestamptz DEFAULT (now()) NOT NULL,
  PRIMARY KEY ("id")
);

-- BackgroundJob (new table)
CREATE TABLE IF NOT EXISTS "public"."BackgroundJob" (
  "id" text NOT NULL,
  "workspaceId" text,
  "type" text NOT NULL,
  "payload" json,
  "dedupeKey" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempts" int4 DEFAULT 0 NOT NULL,
  "nextAttemptAt" timestamptz,
  "lockedBy" text,
  "lockedAt" timestamptz,
  "lastError" text,
  "createdAt" timestamptz DEFAULT (now()) NOT NULL,
  "finishedAt" timestamptz,
  PRIMARY KEY ("id"),
  CONSTRAINT "BackgroundJob_status_check_v1" CHECK ("status" IN ('queued', 'running', 'done', 'dead'))
);

-- DailyAttributionRollup (new table)
CREATE TABLE IF NOT EXISTS "public"."DailyAttributionRollup" (
  "id" text NOT NULL,
  "workspaceId" text NOT NULL,
  "day" character varying(10) NOT NULL,
  "locationId" text,
  "model" text NOT NULL,
  "channel" text NOT NULL,
  "campaign" text NOT NULL,
  "isNewCustomer" bool NOT NULL,
  "creditedOrders" numeric NOT NULL,
  "attributedMinorUnits" int8 NOT NULL,
  "refundMinorUnits" int8 DEFAULT '0'::int8 NOT NULL,
  "currency" character varying(3) NOT NULL,
  "builtAt" timestamptz DEFAULT (now()) NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "DailyAttributionRollup_model_check_v1" CHECK ("model" IN ('first_touch', 'last_touch', 'last_non_direct', 'linear', 'time_decay', 'position_based'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS "Touch_workspaceId_gclid_idx_8089351a" ON "public"."Touch" ("workspaceId", "gclid");
CREATE INDEX IF NOT EXISTS "Touch_workspaceId_fbclid_idx_666ebb17" ON "public"."Touch" ("workspaceId", "fbclid");
CREATE INDEX IF NOT EXISTS "Order_bookingId_idx_81c09f54" ON "public"."Order" ("bookingId");
CREATE INDEX IF NOT EXISTS "AttributionCredit_workspaceId_model_idx_e242ed89" ON "public"."AttributionCredit" ("workspaceId", "model");
CREATE INDEX IF NOT EXISTS "RawEvent_workspaceId_receivedAt_idx_c5f9fc12" ON "public"."RawEvent" ("workspaceId", "receivedAt");
CREATE INDEX IF NOT EXISTS "AuditLog_workspaceId_createdAt_idx_9a1670ad" ON "public"."AuditLog" ("workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_action_idx_464b1474" ON "public"."AuditLog" ("action");
CREATE UNIQUE INDEX IF NOT EXISTS "IdempotencyKey_workspaceId_key_key_49ed292b" ON "public"."IdempotencyKey" ("workspaceId", "key");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_workspaceId_createdAt_idx_c19fdf11" ON "public"."WebhookDelivery" ("workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_endpointId_idx_086ea82f" ON "public"."WebhookDelivery" ("endpointId");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_status_idx_e360b375" ON "public"."WebhookDelivery" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "AdAccount_workspaceId_platform_externalAccountId_key_1a83418b" ON "public"."AdAccount" ("workspaceId", "platform", "externalAccountId");
CREATE INDEX IF NOT EXISTS "AdAccount_workspaceId_idx_7628edf2" ON "public"."AdAccount" ("workspaceId");
CREATE UNIQUE INDEX IF NOT EXISTS "AdSpend_workspaceId_dedupeKey_key_82a06160" ON "public"."AdSpend" ("workspaceId", "dedupeKey");
CREATE INDEX IF NOT EXISTS "AdSpend_workspaceId_date_idx_10ace5d2" ON "public"."AdSpend" ("workspaceId", "date");
CREATE UNIQUE INDEX IF NOT EXISTS "FxRate_date_base_quote_key_d9e6fe1e" ON "public"."FxRate" ("date", "base", "quote");
CREATE INDEX IF NOT EXISTS "DailyRollup_workspaceId_day_idx_18b72d54" ON "public"."DailyRollup" ("workspaceId", "day");
CREATE INDEX IF NOT EXISTS "RollupDirtyDay_workspaceId_day_idx_5e18d8de" ON "public"."RollupDirtyDay" ("workspaceId", "day");
CREATE INDEX IF NOT EXISTS "BackgroundJob_status_nextAttemptAt_idx_1ca4fd75" ON "public"."BackgroundJob" ("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "BackgroundJob_dedupeKey_idx_937c17ae" ON "public"."BackgroundJob" ("dedupeKey");
CREATE INDEX IF NOT EXISTS "DailyAttributionRollup_workspaceId_model_day_idx_e30718aa" ON "public"."DailyAttributionRollup" ("workspaceId", "model", "day");

-- Foreign keys (new relations only)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_bookingId_fkey_v1') AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = '"public"."Order"'::regclass AND con.contype = 'f' AND a.attname = 'bookingId') THEN
    ALTER TABLE "public"."Order" ADD CONSTRAINT "Order_bookingId_fkey_v1" FOREIGN KEY ("bookingId") REFERENCES "public"."Booking" ("id");
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AuditLog_workspaceId_fkey_v1') AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = '"public"."AuditLog"'::regclass AND con.contype = 'f' AND a.attname = 'workspaceId') THEN
    ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_fkey_v1" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace" ("id") ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'IdempotencyKey_workspaceId_fkey_v1') AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = '"public"."IdempotencyKey"'::regclass AND con.contype = 'f' AND a.attname = 'workspaceId') THEN
    ALTER TABLE "public"."IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_workspaceId_fkey_v1" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace" ("id") ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WebhookDelivery_workspaceId_fkey_v1') AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = '"public"."WebhookDelivery"'::regclass AND con.contype = 'f' AND a.attname = 'workspaceId') THEN
    ALTER TABLE "public"."WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_workspaceId_fkey_v1" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace" ("id") ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdAccount_workspaceId_fkey_v1') AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = '"public"."AdAccount"'::regclass AND con.contype = 'f' AND a.attname = 'workspaceId') THEN
    ALTER TABLE "public"."AdAccount" ADD CONSTRAINT "AdAccount_workspaceId_fkey_v1" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace" ("id") ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdSpend_workspaceId_fkey_v1') AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = '"public"."AdSpend"'::regclass AND con.contype = 'f' AND a.attname = 'workspaceId') THEN
    ALTER TABLE "public"."AdSpend" ADD CONSTRAINT "AdSpend_workspaceId_fkey_v1" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace" ("id") ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdSpend_adAccountId_fkey_v1') AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = '"public"."AdSpend"'::regclass AND con.contype = 'f' AND a.attname = 'adAccountId') THEN
    ALTER TABLE "public"."AdSpend" ADD CONSTRAINT "AdSpend_adAccountId_fkey_v1" FOREIGN KEY ("adAccountId") REFERENCES "public"."AdAccount" ("id") ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DailyRollup_workspaceId_fkey_v1') AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = '"public"."DailyRollup"'::regclass AND con.contype = 'f' AND a.attname = 'workspaceId') THEN
    ALTER TABLE "public"."DailyRollup" ADD CONSTRAINT "DailyRollup_workspaceId_fkey_v1" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace" ("id") ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RollupDirtyDay_workspaceId_fkey_v1') AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = '"public"."RollupDirtyDay"'::regclass AND con.contype = 'f' AND a.attname = 'workspaceId') THEN
    ALTER TABLE "public"."RollupDirtyDay" ADD CONSTRAINT "RollupDirtyDay_workspaceId_fkey_v1" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace" ("id") ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DailyAttributionRollup_workspaceId_fkey_v1') AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.conrelid = '"public"."DailyAttributionRollup"'::regclass AND con.contype = 'f' AND a.attname = 'workspaceId') THEN
    ALTER TABLE "public"."DailyAttributionRollup" ADD CONSTRAINT "DailyAttributionRollup_workspaceId_fkey_v1" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace" ("id") ON DELETE CASCADE;
  END IF;
END $$;

