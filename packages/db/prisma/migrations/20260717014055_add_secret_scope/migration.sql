-- AlterTable
ALTER TABLE "policy_rule_targets" ADD COLUMN     "secret_scope" TEXT;

-- Hand-appended (Prisma has no native CHECK support): widen the kind_shape CHECK
-- so a `secret` target names EITHER a specific `secret_id` OR a `secret_scope`
-- ("all secrets at that level") — exactly one (step 8). Also pin the scope columns
-- to their kinds: `app_connection_scope` only on `app`, `secret_scope` only on
-- `secret`. See plans/policy-engine.md §356.
ALTER TABLE "policy_rule_targets" DROP CONSTRAINT "policy_rule_targets_kind_shape";
ALTER TABLE "policy_rule_targets" ADD CONSTRAINT "policy_rule_targets_kind_shape" CHECK (
    (kind = 'app' AND "app_provider" IS NOT NULL AND "app_connection_id" IS NULL AND "secret_id" IS NULL AND "secret_scope" IS NULL AND "host_pattern" IS NULL)
    OR (kind = 'connection' AND "app_connection_id" IS NOT NULL AND "app_provider" IS NULL AND "app_connection_scope" IS NULL AND "secret_id" IS NULL AND "secret_scope" IS NULL AND "host_pattern" IS NULL)
    OR (kind = 'secret' AND num_nonnulls("secret_id", "secret_scope") = 1 AND "app_provider" IS NULL AND "app_connection_id" IS NULL AND "app_connection_scope" IS NULL AND "host_pattern" IS NULL)
    OR (kind = 'network' AND "host_pattern" IS NOT NULL AND "app_provider" IS NULL AND "app_connection_id" IS NULL AND "app_connection_scope" IS NULL AND "secret_id" IS NULL AND "secret_scope" IS NULL)
);
