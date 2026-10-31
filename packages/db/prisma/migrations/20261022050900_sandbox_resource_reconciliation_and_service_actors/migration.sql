-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actor_kind" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "service_actor" TEXT;

-- AlterTable
ALTER TABLE "sandbox_home_growth_operations" ADD COLUMN     "admitted_desired_generation" INTEGER,
ADD COLUMN     "claim_expires_at" TIMESTAMP(3),
ADD COLUMN     "claimed_by" TEXT,
ADD COLUMN     "desired_snapshot" JSONB,
ADD COLUMN     "enrollment_generation" INTEGER,
ADD COLUMN     "enrollment_ref" TEXT,
ADD COLUMN     "expected_revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "initiator" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'grow',
ADD COLUMN     "reservation_node_uid" TEXT,
ADD COLUMN     "reservation_receipt" TEXT;

-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN     "resource_desired_generation" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "resource_desired_profile_id" TEXT,
ADD COLUMN     "resource_observed_generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resource_reconcile_after" TIMESTAMP(3),
ADD COLUMN     "resource_reconcile_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resource_reconcile_reason" TEXT;

-- CreateIndex
CREATE INDEX "sandbox_home_growth_operations_kind_state_claimed_at_idx" ON "sandbox_home_growth_operations"("kind", "state", "claimed_at");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_home_growth_operations_sandbox_id_idempotency_key_key" ON "sandbox_home_growth_operations"("sandbox_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "sandboxes_runner_id_resource_reconcile_after_idx" ON "sandboxes"("runner_id", "resource_reconcile_after");

