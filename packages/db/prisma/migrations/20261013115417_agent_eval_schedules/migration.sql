-- AlterTable
ALTER TABLE "agent_eval_runs" ADD COLUMN     "trigger" TEXT NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "agent_eval_schedules" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabled_reason" TEXT,
    "created_by_user_id" TEXT,
    "next_fire_at" TIMESTAMP(3) NOT NULL,
    "last_fired_at" TIMESTAMP(3),
    "last_outcome" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_eval_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_eval_schedules_agent_id_key" ON "agent_eval_schedules"("agent_id");

-- CreateIndex
CREATE INDEX "agent_eval_schedules_enabled_next_fire_at_idx" ON "agent_eval_schedules"("enabled", "next_fire_at");

-- AddForeignKey
ALTER TABLE "agent_eval_schedules" ADD CONSTRAINT "agent_eval_schedules_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_eval_schedules" ADD CONSTRAINT "agent_eval_schedules_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
