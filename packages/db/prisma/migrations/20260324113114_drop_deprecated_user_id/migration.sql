-- ============================================================================
-- Migration 3: Drop deprecated user_id columns from data tables
--
-- These columns were kept during the account layer transition.
-- All code now uses account_id for data scoping.
-- AuditLog.user_id is kept permanently for attribution.
-- ============================================================================

ALTER TABLE "agents" DROP COLUMN "user_id";
ALTER TABLE "secrets" DROP COLUMN "user_id";
ALTER TABLE "policy_rules" DROP COLUMN "user_id";
ALTER TABLE "connected_services" DROP COLUMN "user_id";
ALTER TABLE "vault_connections" DROP COLUMN "user_id";
ALTER TABLE "onboarding_surveys" DROP COLUMN "user_id";

-- Also drop the legacy api_key field from users (fully migrated to api_keys table)
ALTER TABLE "users" DROP COLUMN IF EXISTS "api_key";
