-- ============================================================================
-- Migration 1: Add Account layer schema (safe for existing data)
--
-- Creates new tables and adds nullable account_id columns.
-- Does NOT backfill data or add NOT NULL constraints — that's migration 2.
-- ============================================================================

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "stripe_customer_id" TEXT,
    "subscription_status" TEXT NOT NULL DEFAULT 'free',
    "demo_seeded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_members" (
    "account_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_members_pkey" PRIMARY KEY ("account_id","user_id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- Add nullable account_id to all data tables (will be made NOT NULL after backfill)
ALTER TABLE "agents" ADD COLUMN "account_id" TEXT;
ALTER TABLE "secrets" ADD COLUMN "account_id" TEXT;
ALTER TABLE "policy_rules" ADD COLUMN "account_id" TEXT;
ALTER TABLE "connected_services" ADD COLUMN "account_id" TEXT;
ALTER TABLE "vault_connections" ADD COLUMN "account_id" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "account_id" TEXT;
ALTER TABLE "onboarding_surveys" ADD COLUMN "account_id" TEXT;

-- CreateIndex (new tables)
CREATE UNIQUE INDEX "accounts_stripe_customer_id_key" ON "accounts"("stripe_customer_id");
CREATE INDEX "account_members_user_id_idx" ON "account_members"("user_id");
CREATE UNIQUE INDEX "api_keys_key_key" ON "api_keys"("key");
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex (account_id on data tables)
CREATE INDEX "agents_account_id_idx" ON "agents"("account_id");
CREATE INDEX "secrets_account_id_idx" ON "secrets"("account_id");
CREATE INDEX "policy_rules_account_id_idx" ON "policy_rules"("account_id");
CREATE INDEX "audit_logs_account_id_created_at_idx" ON "audit_logs"("account_id", "created_at");

-- AddForeignKey (new tables only — data table FKs added after backfill)
ALTER TABLE "account_members" ADD CONSTRAINT "account_members_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_members" ADD CONSTRAINT "account_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounts" ALTER COLUMN "updated_at" DROP DEFAULT;
