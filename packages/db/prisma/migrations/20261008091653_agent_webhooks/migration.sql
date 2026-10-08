-- CreateTable
CREATE TABLE "agent_webhooks" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabled_reason" TEXT,
    "origin_conversation_id" TEXT,
    "created_by_user_id" TEXT,
    "last_received_at" TIMESTAMP(3),
    "last_outcome" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_webhooks_token_key" ON "agent_webhooks"("token");

-- CreateIndex
CREATE INDEX "agent_webhooks_agent_id_idx" ON "agent_webhooks"("agent_id");

-- AddForeignKey
ALTER TABLE "agent_webhooks" ADD CONSTRAINT "agent_webhooks_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_webhooks" ADD CONSTRAINT "agent_webhooks_origin_conversation_id_fkey" FOREIGN KEY ("origin_conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_webhooks" ADD CONSTRAINT "agent_webhooks_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
