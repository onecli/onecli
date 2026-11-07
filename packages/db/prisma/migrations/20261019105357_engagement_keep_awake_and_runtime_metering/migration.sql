-- AlterTable
ALTER TABLE "process_watches" ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'agent';

-- AlterTable
ALTER TABLE "sandbox_ports" ADD COLUMN     "start_command" TEXT;

-- AlterTable
ALTER TABLE "sandbox_processes" ADD COLUMN     "cpu_busy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "last_output_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN     "last_engaged_at" TIMESTAMP(3),
ADD COLUMN     "stop_reason" TEXT,
ADD COLUMN     "wake_reason" TEXT;

-- CreateTable
CREATE TABLE "sandbox_runtime_intervals" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "sandbox_id" TEXT NOT NULL,
    "container_ref" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "end_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_runtime_intervals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_usage_daily" (
    "organization_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "awake_seconds" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runtime_usage_daily_pkey" PRIMARY KEY ("organization_id","agent_id","day")
);

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_runtime_intervals_container_ref_key" ON "sandbox_runtime_intervals"("container_ref");

-- CreateIndex
CREATE INDEX "sandbox_runtime_intervals_agent_id_ended_at_idx" ON "sandbox_runtime_intervals"("agent_id", "ended_at");

-- CreateIndex
CREATE INDEX "sandbox_runtime_intervals_organization_id_ended_at_idx" ON "sandbox_runtime_intervals"("organization_id", "ended_at");

-- CreateIndex
CREATE INDEX "sandbox_runtime_intervals_ended_at_idx" ON "sandbox_runtime_intervals"("ended_at");

-- CreateIndex
CREATE INDEX "runtime_usage_daily_agent_id_day_idx" ON "runtime_usage_daily"("agent_id", "day");

-- ── Hand-appended (Prisma cannot express these) ──────────────────────────────
-- `parked` joins the terminal process states: a parked process always says
-- when it ended, exactly like exited/stopped/lost.
ALTER TABLE "sandbox_processes"
  DROP CONSTRAINT "sandbox_processes_ended_coherent";
ALTER TABLE "sandbox_processes"
  ADD CONSTRAINT "sandbox_processes_ended_coherent"
  CHECK (("status" IN ('exited', 'stopped', 'lost', 'parked')) = ("ended_at" IS NOT NULL));

-- The ledger's two invariants: a run never ends before it starts, and a
-- sandbox runs at most ONE container at a time, so at most one row per
-- sandbox is open. The partial unique is what makes a racing second open
-- (two start reports for different container refs) a conflict instead of a
-- double-counted run.
ALTER TABLE "sandbox_runtime_intervals"
  ADD CONSTRAINT "sandbox_runtime_intervals_ordered"
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");
CREATE UNIQUE INDEX "sandbox_runtime_intervals_one_open_per_sandbox"
  ON "sandbox_runtime_intervals"("sandbox_id") WHERE "ended_at" IS NULL;
