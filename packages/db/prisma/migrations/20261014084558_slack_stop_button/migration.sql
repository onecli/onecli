-- AlterTable
ALTER TABLE "agent_channels" ADD COLUMN     "events_sync_attempted_at" TIMESTAMP(3),
ADD COLUMN     "synced_events" TEXT;

-- CreateIndex
CREATE INDEX "channel_turn_receipts_agent_channel_id_channel_message_ts_idx" ON "channel_turn_receipts"("agent_channel_id", "channel", "message_ts");
