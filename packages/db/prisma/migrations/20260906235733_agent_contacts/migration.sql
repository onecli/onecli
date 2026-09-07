-- CreateTable
CREATE TABLE "agent_contacts" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "policy" TEXT NOT NULL DEFAULT 'ask',
    "decided_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_contacts_agent_id_kind_external_ref_key" ON "agent_contacts"("agent_id", "kind", "external_ref");

-- AddForeignKey
ALTER TABLE "agent_contacts" ADD CONSTRAINT "agent_contacts_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_contacts" ADD CONSTRAINT "agent_contacts_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
