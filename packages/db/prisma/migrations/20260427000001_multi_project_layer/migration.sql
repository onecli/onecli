-- Multi-project layer migration
--
-- Splits the workspace concept off Account into a new Project model, and
-- introduces Organization as the billing + collaboration entity above
-- projects. After this migration:
--   accounts            -> renamed to "projects" (data preserved)
--   account_id columns  -> renamed to "project_id" (data preserved)
--   account_members     -> migrated to "organization_members", then dropped
--   billing fields      -> moved from accounts/projects to organizations
--
-- Backfill strategy: each existing account becomes one project under a
-- newly-created organization (1:1). The org inherits the account's billing
-- state, so existing Stripe customers and subscription statuses keep working.

-- ── Phase 1: Create new tables ──────────────────────────────────────────

CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "stripe_customer_id" TEXT,
    "subscription_status" TEXT NOT NULL DEFAULT 'free',
    "demo_seeded" BOOLEAN NOT NULL DEFAULT false,
    "onboarding_completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organization_members" (
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("organization_id","user_id")
);

CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");
CREATE UNIQUE INDEX "organizations_stripe_customer_id_key" ON "organizations"("stripe_customer_id");
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");

-- ── Phase 2: Backfill organizations from existing accounts ──────────────
-- Each existing account gets exactly one organization. We use the account
-- id as the org id (prefixed) so the mapping is deterministic and we don't
-- need a temp table.

INSERT INTO "organizations" (
    "id", "name", "slug",
    "stripe_customer_id", "subscription_status", "demo_seeded", "onboarding_completed_at",
    "created_at", "updated_at"
)
SELECT
    'org_' || a."id",
    COALESCE(a."name", 'Personal'),
    COALESCE(NULLIF(LOWER(REGEXP_REPLACE(COALESCE(a."name", ''), '[^a-zA-Z0-9]+', '-', 'g')), ''), 'org')
        || '-' || SUBSTRING(a."id", 1, 8),
    a."stripe_customer_id",
    a."subscription_status",
    a."demo_seeded",
    a."onboarding_completed_at",
    a."created_at",
    a."updated_at"
FROM "accounts" a;

-- Migrate account_members rows to organization_members. Each account_member
-- row becomes an organization_member of the org we just created.
INSERT INTO "organization_members" (
    "organization_id", "user_id", "user_email", "role", "created_at"
)
SELECT
    'org_' || am."account_id",
    am."user_id",
    am."user_email",
    am."role",
    am."created_at"
FROM "account_members" am;

-- ── Phase 3: Rename accounts → projects (preserves data) ────────────────

ALTER TABLE "accounts" RENAME TO "projects";
ALTER TABLE "projects" RENAME CONSTRAINT "accounts_pkey" TO "projects_pkey";
ALTER INDEX "accounts_stripe_customer_id_key" RENAME TO "projects_stripe_customer_id_key_old";

-- The created_by_user_id FK survives the rename but its constraint name still
-- says "accounts_..." — fix that too.
ALTER TABLE "projects" RENAME CONSTRAINT "accounts_created_by_user_id_fkey" TO "projects_created_by_user_id_fkey";

-- ── Phase 4: Add organization_id to projects, link, drop billing cols ───

ALTER TABLE "projects" ADD COLUMN "organization_id" TEXT;
ALTER TABLE "projects" ADD COLUMN "slug" TEXT;

UPDATE "projects" SET "organization_id" = 'org_' || "id";

-- Backfill slug from account name (deterministic, unique within the new
-- 1:1 org). Idempotent because each new org has exactly one project.
UPDATE "projects"
SET "slug" = COALESCE(
    NULLIF(LOWER(REGEXP_REPLACE(COALESCE("name", ''), '[^a-zA-Z0-9]+', '-', 'g')), ''),
    'default'
);

ALTER TABLE "projects" ALTER COLUMN "organization_id" SET NOT NULL;

ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "projects_organization_id_idx" ON "projects"("organization_id");
CREATE UNIQUE INDEX "projects_organization_id_slug_key" ON "projects"("organization_id", "slug");

-- Billing fields move to organizations — drop from projects.
ALTER TABLE "projects" DROP COLUMN "stripe_customer_id";
ALTER TABLE "projects" DROP COLUMN "subscription_status";
ALTER TABLE "projects" DROP COLUMN "demo_seeded";
ALTER TABLE "projects" DROP COLUMN "onboarding_completed_at";

-- The unique index on stripe_customer_id was renamed to "_old" earlier;
-- drop it now that the column is gone.
DROP INDEX IF EXISTS "projects_stripe_customer_id_key_old";

-- ── Phase 5: Rename account_id → project_id on resource tables ──────────
-- Each table: drop old FK + indexes, rename column, recreate FK + indexes
-- pointing to projects(id).

-- agents
ALTER TABLE "agents" DROP CONSTRAINT "agents_account_id_fkey";
DROP INDEX "agents_account_id_idx";
DROP INDEX "agents_account_id_identifier_key";
ALTER TABLE "agents" RENAME COLUMN "account_id" TO "project_id";
CREATE INDEX "agents_project_id_idx" ON "agents"("project_id");
CREATE UNIQUE INDEX "agents_project_id_identifier_key" ON "agents"("project_id", "identifier");
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- secrets
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_account_id_fkey";
DROP INDEX "secrets_account_id_idx";
ALTER TABLE "secrets" RENAME COLUMN "account_id" TO "project_id";
CREATE INDEX "secrets_project_id_idx" ON "secrets"("project_id");
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- policy_rules
ALTER TABLE "policy_rules" DROP CONSTRAINT "policy_rules_account_id_fkey";
DROP INDEX "policy_rules_account_id_idx";
ALTER TABLE "policy_rules" RENAME COLUMN "account_id" TO "project_id";
CREATE INDEX "policy_rules_project_id_idx" ON "policy_rules"("project_id");
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- api_keys
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_account_id_fkey";
ALTER TABLE "api_keys" RENAME COLUMN "account_id" TO "project_id";
CREATE INDEX "api_keys_project_id_idx" ON "api_keys"("project_id");
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- connected_services
ALTER TABLE "connected_services" DROP CONSTRAINT "connected_services_account_id_fkey";
DROP INDEX "connected_services_account_id_provider_key";
ALTER TABLE "connected_services" RENAME COLUMN "account_id" TO "project_id";
CREATE UNIQUE INDEX "connected_services_project_id_provider_key" ON "connected_services"("project_id", "provider");
ALTER TABLE "connected_services" ADD CONSTRAINT "connected_services_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- audit_logs
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_account_id_fkey";
DROP INDEX "audit_logs_account_id_created_at_idx";
ALTER TABLE "audit_logs" RENAME COLUMN "account_id" TO "project_id";
CREATE INDEX "audit_logs_project_id_created_at_idx" ON "audit_logs"("project_id", "created_at");
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- request_logs (no FK in schema, but rename column + index for consistency)
DROP INDEX "request_logs_account_id_created_at_idx";
ALTER TABLE "request_logs" RENAME COLUMN "account_id" TO "project_id";
CREATE INDEX "request_logs_project_id_created_at_idx" ON "request_logs"("project_id", "created_at");

-- vault_connections
ALTER TABLE "vault_connections" DROP CONSTRAINT "vault_connections_account_id_fkey";
DROP INDEX "vault_connections_account_id_provider_key";
ALTER TABLE "vault_connections" RENAME COLUMN "account_id" TO "project_id";
CREATE UNIQUE INDEX "vault_connections_project_id_provider_key" ON "vault_connections"("project_id", "provider");
ALTER TABLE "vault_connections" ADD CONSTRAINT "vault_connections_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- onboarding_surveys
ALTER TABLE "onboarding_surveys" DROP CONSTRAINT "onboarding_surveys_account_id_fkey";
DROP INDEX "onboarding_surveys_account_id_key";
ALTER TABLE "onboarding_surveys" RENAME COLUMN "account_id" TO "project_id";
CREATE UNIQUE INDEX "onboarding_surveys_project_id_key" ON "onboarding_surveys"("project_id");
ALTER TABLE "onboarding_surveys" ADD CONSTRAINT "onboarding_surveys_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- app_connections
ALTER TABLE "app_connections" DROP CONSTRAINT "app_connections_account_id_fkey";
DROP INDEX "app_connections_account_id_provider_idx";
ALTER TABLE "app_connections" RENAME COLUMN "account_id" TO "project_id";
CREATE INDEX "app_connections_project_id_provider_idx" ON "app_connections"("project_id", "provider");
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- app_configs
ALTER TABLE "app_configs" DROP CONSTRAINT "app_configs_account_id_fkey";
DROP INDEX "app_configs_account_id_provider_key";
ALTER TABLE "app_configs" RENAME COLUMN "account_id" TO "project_id";
CREATE UNIQUE INDEX "app_configs_project_id_provider_key" ON "app_configs"("project_id", "provider");
ALTER TABLE "app_configs" ADD CONSTRAINT "app_configs_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- platform_deployments
ALTER TABLE "platform_deployments" DROP CONSTRAINT "platform_deployments_account_id_fkey";
DROP INDEX "platform_deployments_account_id_idx";
ALTER TABLE "platform_deployments" RENAME COLUMN "account_id" TO "project_id";
CREATE INDEX "platform_deployments_project_id_idx" ON "platform_deployments"("project_id");
ALTER TABLE "platform_deployments" ADD CONSTRAINT "platform_deployments_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Phase 6: Add FKs to organization_members and drop account_members ───

ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TABLE "account_members";
