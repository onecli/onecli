-- AlterTable
ALTER TABLE "agent_reach_grants" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "channel_thread_links" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "channel_space_reconciliations" (
    "agent_channel_id" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "grant_cursor" TEXT,
    "link_cursor" TEXT,
    "scan_links_next" BOOLEAN NOT NULL DEFAULT false,
    "last_attempt_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "lease_token" TEXT,
    "lease_expires_at" TIMESTAMP(3),

    CONSTRAINT "channel_space_reconciliations_pkey" PRIMARY KEY ("agent_channel_id")
);

-- CreateIndex
CREATE INDEX "channel_space_reconciliations_next_attempt_at_last_attempt__idx" ON "channel_space_reconciliations"("next_attempt_at", "last_attempt_at");

-- CreateIndex
CREATE INDEX "channel_thread_links_agent_channel_id_kind_id_idx" ON "channel_thread_links"("agent_channel_id", "kind", "id");

-- AddForeignKey
ALTER TABLE "channel_space_reconciliations" ADD CONSTRAINT "channel_space_reconciliations_agent_channel_id_fkey" FOREIGN KEY ("agent_channel_id") REFERENCES "agent_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
