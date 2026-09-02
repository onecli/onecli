-- CreateTable
CREATE TABLE "agent_reach_grants" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "subject_label" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "prompt_refs" JSONB,
    "decided_by_user_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_reach_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_reach_grants_agent_id_state_idx" ON "agent_reach_grants"("agent_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "agent_reach_grants_agent_id_integration_id_subject_kind_ext_key" ON "agent_reach_grants"("agent_id", "integration_id", "subject_kind", "external_ref");

-- AddForeignKey
ALTER TABLE "agent_reach_grants" ADD CONSTRAINT "agent_reach_grants_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_reach_grants" ADD CONSTRAINT "agent_reach_grants_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "channel_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_reach_grants" ADD CONSTRAINT "agent_reach_grants_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
