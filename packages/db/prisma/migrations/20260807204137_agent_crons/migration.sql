-- CreateTable
CREATE TABLE "agent_crons" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabled_reason" TEXT,
    "origin_conversation_id" TEXT,
    "created_by_user_id" TEXT,
    "next_fire_at" TIMESTAMP(3) NOT NULL,
    "last_fired_at" TIMESTAMP(3),
    "last_outcome" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_crons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_crons_enabled_next_fire_at_idx" ON "agent_crons"("enabled", "next_fire_at");

-- CreateIndex
CREATE INDEX "agent_crons_agent_id_idx" ON "agent_crons"("agent_id");

-- AddForeignKey
ALTER TABLE "agent_crons" ADD CONSTRAINT "agent_crons_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_crons" ADD CONSTRAINT "agent_crons_origin_conversation_id_fkey" FOREIGN KEY ("origin_conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_crons" ADD CONSTRAINT "agent_crons_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
