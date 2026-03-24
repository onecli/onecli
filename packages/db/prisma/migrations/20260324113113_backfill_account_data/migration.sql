-- ============================================================================
-- Migration 2: Backfill account data + finalize constraints
--
-- Creates one account per existing user, backfills account_id on all data
-- tables, then adds NOT NULL constraints, foreign keys, and new unique indexes.
-- ============================================================================

-- Section 1: Backfill data using temp mapping table
-- ----------------------------------------------------------------------------

CREATE TEMP TABLE _user_account_map AS
SELECT id AS user_id, gen_random_uuid()::text AS account_id
FROM users;

-- Create one account per user (copy billing fields from user)
INSERT INTO accounts (id, name, stripe_customer_id, subscription_status, demo_seeded, created_at, updated_at)
SELECT
    uam.account_id,
    u.name,
    u.stripe_customer_id,
    u.subscription_status,
    u.demo_seeded,
    NOW(),
    NOW()
FROM users u
JOIN _user_account_map uam ON uam.user_id = u.id;

-- Link each user to their account as owner
INSERT INTO account_members (account_id, user_id, role, created_at)
SELECT account_id, user_id, 'owner', NOW()
FROM _user_account_map;

-- Migrate existing API keys to the api_keys table
INSERT INTO api_keys (id, key, user_id, account_id, created_at)
SELECT
    gen_random_uuid()::text,
    u.api_key,
    uam.user_id,
    uam.account_id,
    NOW()
FROM users u
JOIN _user_account_map uam ON uam.user_id = u.id
WHERE u.api_key IS NOT NULL;

-- Backfill account_id on all data tables
UPDATE agents SET account_id = uam.account_id
FROM _user_account_map uam WHERE uam.user_id = agents.user_id;

UPDATE secrets SET account_id = uam.account_id
FROM _user_account_map uam WHERE uam.user_id = secrets.user_id;

UPDATE policy_rules SET account_id = uam.account_id
FROM _user_account_map uam WHERE uam.user_id = policy_rules.user_id;

UPDATE connected_services SET account_id = uam.account_id
FROM _user_account_map uam WHERE uam.user_id = connected_services.user_id;

UPDATE vault_connections SET account_id = uam.account_id
FROM _user_account_map uam WHERE uam.user_id = vault_connections.user_id;

UPDATE audit_logs SET account_id = uam.account_id
FROM _user_account_map uam WHERE uam.user_id = audit_logs.user_id;

UPDATE onboarding_surveys SET account_id = uam.account_id
FROM _user_account_map uam WHERE uam.user_id = onboarding_surveys.user_id;

DROP TABLE _user_account_map;

-- Section 2: Make account_id NOT NULL
-- ----------------------------------------------------------------------------

ALTER TABLE "agents" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "secrets" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "policy_rules" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "connected_services" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "vault_connections" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "audit_logs" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "onboarding_surveys" ALTER COLUMN "account_id" SET NOT NULL;

-- Section 3: Drop old unique constraints and add new account-based ones
-- ----------------------------------------------------------------------------

DROP INDEX IF EXISTS "agent_user_id_identifier_key";
DROP INDEX IF EXISTS "agents_user_id_identifier_key";
CREATE UNIQUE INDEX "agents_account_id_identifier_key" ON "agents"("account_id", "identifier");

DROP INDEX IF EXISTS "connected_service_user_id_provider_key";
DROP INDEX IF EXISTS "connected_services_user_id_provider_key";
CREATE UNIQUE INDEX "connected_services_account_id_provider_key" ON "connected_services"("account_id", "provider");

DROP INDEX IF EXISTS "vault_connection_user_id_provider_key";
DROP INDEX IF EXISTS "vault_connections_user_id_provider_key";
CREATE UNIQUE INDEX "vault_connections_account_id_provider_key" ON "vault_connections"("account_id", "provider");

DROP INDEX IF EXISTS "onboarding_surveys_user_id_key";
CREATE UNIQUE INDEX "onboarding_surveys_account_id_key" ON "onboarding_surveys"("account_id");

-- Section 4: Drop old user_id foreign keys + indexes, add account_id foreign keys
-- ----------------------------------------------------------------------------

-- Drop old foreign keys (user_id → users on data tables)
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agent_user_id_fkey";
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_user_id_fkey";
ALTER TABLE "secrets" DROP CONSTRAINT IF EXISTS "secret_user_id_fkey";
ALTER TABLE "secrets" DROP CONSTRAINT IF EXISTS "secrets_user_id_fkey";
ALTER TABLE "policy_rules" DROP CONSTRAINT IF EXISTS "policy_rule_user_id_fkey";
ALTER TABLE "policy_rules" DROP CONSTRAINT IF EXISTS "policy_rules_user_id_fkey";
ALTER TABLE "connected_services" DROP CONSTRAINT IF EXISTS "connected_service_user_id_fkey";
ALTER TABLE "connected_services" DROP CONSTRAINT IF EXISTS "connected_services_user_id_fkey";
ALTER TABLE "vault_connections" DROP CONSTRAINT IF EXISTS "vault_connection_user_id_fkey";
ALTER TABLE "vault_connections" DROP CONSTRAINT IF EXISTS "vault_connections_user_id_fkey";
ALTER TABLE "onboarding_surveys" DROP CONSTRAINT IF EXISTS "onboarding_surveys_user_id_fkey";

-- Drop old user_id indexes
DROP INDEX IF EXISTS "agent_user_id_idx";
DROP INDEX IF EXISTS "agents_user_id_idx";
DROP INDEX IF EXISTS "secret_user_id_idx";
DROP INDEX IF EXISTS "secrets_user_id_idx";
DROP INDEX IF EXISTS "policy_rule_user_id_idx";
DROP INDEX IF EXISTS "policy_rules_user_id_idx";
DROP INDEX IF EXISTS "audit_log_user_id_created_at_idx";
DROP INDEX IF EXISTS "audit_logs_user_id_created_at_idx";

-- Drop old stripe unique index on users
DROP INDEX IF EXISTS "user_stripe_customer_id_key";
DROP INDEX IF EXISTS "users_stripe_customer_id_key";

-- Add account_id foreign keys on data tables
ALTER TABLE "agents" ADD CONSTRAINT "agents_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "connected_services" ADD CONSTRAINT "connected_services_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vault_connections" ADD CONSTRAINT "vault_connections_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "onboarding_surveys" ADD CONSTRAINT "onboarding_surveys_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Section 5: Clean up users table (remove fields moved to accounts)
-- ----------------------------------------------------------------------------

ALTER TABLE "users" DROP COLUMN IF EXISTS "stripe_customer_id";
ALTER TABLE "users" DROP COLUMN IF EXISTS "subscription_status";
ALTER TABLE "users" DROP COLUMN IF EXISTS "demo_seeded";
