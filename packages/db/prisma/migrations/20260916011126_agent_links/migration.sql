-- CreateTable
CREATE TABLE "agent_links" (
    "id" TEXT NOT NULL,
    "agent_a_id" TEXT NOT NULL,
    "agent_b_id" TEXT NOT NULL,
    "policy_a" TEXT NOT NULL DEFAULT 'ask',
    "policy_b" TEXT NOT NULL DEFAULT 'ask',
    "decided_by_a_user_id" TEXT,
    "decided_by_b_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_links_agent_b_id_idx" ON "agent_links"("agent_b_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_links_agent_a_id_agent_b_id_key" ON "agent_links"("agent_a_id", "agent_b_id");

-- AddForeignKey
ALTER TABLE "agent_links" ADD CONSTRAINT "agent_links_agent_a_id_fkey" FOREIGN KEY ("agent_a_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_links" ADD CONSTRAINT "agent_links_agent_b_id_fkey" FOREIGN KEY ("agent_b_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_links" ADD CONSTRAINT "agent_links_decided_by_a_user_id_fkey" FOREIGN KEY ("decided_by_a_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_links" ADD CONSTRAINT "agent_links_decided_by_b_user_id_fkey" FOREIGN KEY ("decided_by_b_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
