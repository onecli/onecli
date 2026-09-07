-- CreateTable
CREATE TABLE "action_approvals" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "origin_turn_id" TEXT,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "decided_by_user_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "prompt_refs" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "action_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "action_approvals_agent_id_status_idx" ON "action_approvals"("agent_id", "status");

-- AddForeignKey
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
