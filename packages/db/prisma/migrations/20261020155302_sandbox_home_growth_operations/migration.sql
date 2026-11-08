-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN     "active_home_growth_operation_id" TEXT,
ADD COLUMN     "resource_container_ref" TEXT;

-- CreateTable
CREATE TABLE "sandbox_home_growth_operations" (
    "id" TEXT NOT NULL,
    "sandbox_id" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "expected_attempt_id" TEXT NOT NULL,
    "requested_by_user_id" TEXT NOT NULL,
    "target_gib" INTEGER NOT NULL,
    "resources" JSONB,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "claimed_at" TIMESTAMP(3),
    "observed_device_bytes" BIGINT,
    "observed_filesystem_bytes" BIGINT,
    "archive_sha256" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandbox_home_growth_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sandbox_home_growth_operations_sandbox_id_state_created_at_idx" ON "sandbox_home_growth_operations"("sandbox_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "sandbox_home_growth_operations_state_claimed_at_idx" ON "sandbox_home_growth_operations"("state", "claimed_at");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_home_growth_operations_id_sandbox_id_key" ON "sandbox_home_growth_operations"("id", "sandbox_id");

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_active_home_growth_operation_id_id_fkey" FOREIGN KEY ("active_home_growth_operation_id", "id") REFERENCES "sandbox_home_growth_operations"("id", "sandbox_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_home_growth_operations" ADD CONSTRAINT "sandbox_home_growth_operations_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_home_growth_operations" ADD CONSTRAINT "sandbox_home_growth_operations_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
