-- Dynamic FX: per-company exchange-rate mode (generated from src/prisma/contract.prisma).
-- Run BEFORE deploying a contract.json that contains Workspace.fxRateMode. Idempotent; safe to re-run.
--   psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 -1 -f manual-migrations/20261028_fx_rate_mode.sql


-- Workspace
ALTER TABLE "public"."Workspace" ADD COLUMN IF NOT EXISTS "fxRateMode" text DEFAULT 'transaction_date' NOT NULL;
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT con.conname FROM pg_constraint con
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
           WHERE con.conrelid = '"public"."Workspace"'::regclass AND con.contype = 'c' AND a.attname = 'fxRateMode'
  LOOP
    EXECUTE format('ALTER TABLE "public"."Workspace" DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE "public"."Workspace" ADD CONSTRAINT "Workspace_fxRateMode_check_v1" CHECK ("fxRateMode" IN ('transaction_date', 'latest'));
END $$;

-- Indexes

-- Foreign keys (new relations only)

