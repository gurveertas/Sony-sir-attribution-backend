-- Paid Plans: Pro & Ultra subscription tiers, billing intervals, and usage limits.
-- Safe and idempotent to run on Postgres.

-- 1. Add subscription columns to Workspace
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "plan" text DEFAULT 'free' NOT NULL;
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "billingInterval" text;
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "subscriptionStatus" text DEFAULT 'active' NOT NULL;
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "billingCustomerId" text;
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "subscriptionId" text;
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "currentPeriodStart" timestamptz;
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "currentPeriodEnd" timestamptz;
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "cancelAtPeriodEnd" boolean DEFAULT false NOT NULL;
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "trialEndsAt" timestamptz;
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "monthlyOrderLimit" integer DEFAULT 1000 NOT NULL;
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "currentPeriodOrderCount" integer DEFAULT 0 NOT NULL;

-- 2. Check Constraints
DO $$
BEGIN
  -- Plan tier constraint
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Workspace_plan_check_v1') THEN
    ALTER TABLE "public"."Workspace" DROP CONSTRAINT "Workspace_plan_check_v1";
  END IF;
  ALTER TABLE "public"."Workspace" ADD CONSTRAINT "Workspace_plan_check_v1" 
    CHECK ("plan" IN ('free', 'pro', 'ultra'));

  -- Billing interval constraint
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Workspace_billingInterval_check_v1') THEN
    ALTER TABLE "public"."Workspace" DROP CONSTRAINT "Workspace_billingInterval_check_v1";
  END IF;
  ALTER TABLE "public"."Workspace" ADD CONSTRAINT "Workspace_billingInterval_check_v1" 
    CHECK ("billingInterval" IS NULL OR "billingInterval" IN ('monthly', 'annually'));

  -- Subscription status constraint
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Workspace_subscriptionStatus_check_v1') THEN
    ALTER TABLE "public"."Workspace" DROP CONSTRAINT "Workspace_subscriptionStatus_check_v1";
  END IF;
  ALTER TABLE "public"."Workspace" ADD CONSTRAINT "Workspace_subscriptionStatus_check_v1" 
    CHECK ("subscriptionStatus" IN ('trialing', 'active', 'past_due', 'canceled', 'unpaid'));
END $$;

-- 3. Indexes for fast customer & subscription lookups from webhooks
CREATE INDEX IF NOT EXISTS "idx_workspace_billingCustomerId" ON "public"."Workspace" ("billingCustomerId");
CREATE INDEX IF NOT EXISTS "idx_workspace_subscriptionId" ON "public"."Workspace" ("subscriptionId");

