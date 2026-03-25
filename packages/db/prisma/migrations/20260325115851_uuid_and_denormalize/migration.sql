-- ============================================================================
-- Add denormalized email fields, audit columns, and new relations.
-- Strategy: add columns as nullable → backfill from joins → set NOT NULL.
-- ============================================================================

-- ── Phase 1: Add all new columns as nullable ──────────────────────────────

ALTER TABLE "account_members" ADD COLUMN "user_email" TEXT;

ALTER TABLE "accounts" ADD COLUMN "created_by_user_email" TEXT,
ADD COLUMN "created_by_user_id" TEXT;

ALTER TABLE "agent_secrets" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "created_by_user_id" TEXT,
ADD COLUMN "updated_at" TIMESTAMP(3),
ADD COLUMN "updated_by_user_id" TEXT;

ALTER TABLE "api_keys" ADD COLUMN "updated_at" TIMESTAMP(3),
ADD COLUMN "user_email" TEXT;

ALTER TABLE "audit_logs" ADD COLUMN "user_email" TEXT;

ALTER TABLE "onboarding_surveys" ADD COLUMN "updated_at" TIMESTAMP(3),
ADD COLUMN "user_email" TEXT,
ADD COLUMN "user_id" TEXT;

-- ── Phase 2: Backfill denormalized data from joins ────────────────────────

-- account_members.user_email from users
UPDATE "account_members" am
SET "user_email" = u."email"
FROM "users" u
WHERE u."id" = am."user_id";

-- accounts.created_by from the owner member
UPDATE "accounts" a
SET "created_by_user_id" = am."user_id",
    "created_by_user_email" = u."email"
FROM "account_members" am
JOIN "users" u ON u."id" = am."user_id"
WHERE am."account_id" = a."id" AND am."role" = 'owner';

-- api_keys.user_email from users, updated_at from created_at
UPDATE "api_keys" ak
SET "user_email" = u."email",
    "updated_at" = ak."created_at"
FROM "users" u
WHERE u."id" = ak."user_id";

-- audit_logs.user_email from users
UPDATE "audit_logs" al
SET "user_email" = u."email"
FROM "users" u
WHERE u."id" = al."user_id";

-- agent_secrets.updated_at from created_at
UPDATE "agent_secrets" SET "updated_at" = "created_at";

-- onboarding_surveys.user_id + user_email from the account owner
UPDATE "onboarding_surveys" os
SET "user_id" = am."user_id",
    "user_email" = u."email",
    "updated_at" = os."created_at"
FROM "account_members" am
JOIN "users" u ON u."id" = am."user_id"
WHERE am."account_id" = os."account_id" AND am."role" = 'owner';

-- ── Phase 3: Set NOT NULL constraints ─────────────────────────────────────

ALTER TABLE "account_members" ALTER COLUMN "user_email" SET NOT NULL;
ALTER TABLE "agent_secrets" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "api_keys" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "api_keys" ALTER COLUMN "user_email" SET NOT NULL;
ALTER TABLE "audit_logs" ALTER COLUMN "user_email" SET NOT NULL;
ALTER TABLE "onboarding_surveys" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "onboarding_surveys" ALTER COLUMN "user_email" SET NOT NULL;
ALTER TABLE "onboarding_surveys" ALTER COLUMN "user_id" SET NOT NULL;

-- ── Phase 4: Add foreign keys ─────────────────────────────────────────────

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_secrets" ADD CONSTRAINT "agent_secrets_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_secrets" ADD CONSTRAINT "agent_secrets_updated_by_user_id_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "onboarding_surveys" ADD CONSTRAINT "onboarding_surveys_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
