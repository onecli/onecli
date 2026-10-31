-- AlterTable
ALTER TABLE "channel_ingested_events" ADD COLUMN     "claim_expires_at" TIMESTAMP(3),
ADD COLUMN     "claim_token" TEXT;

-- AlterTable
ALTER TABLE "turns" ADD COLUMN     "source_event_id" TEXT;

-- CreateTable
CREATE TABLE "channel_inbound_events" (
    "id" TEXT NOT NULL,
    "agent_channel_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claim_token" TEXT,
    "claim_expires_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_inbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_inbound_events_next_attempt_at_idx" ON "channel_inbound_events"("next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "channel_inbound_events_agent_channel_id_event_id_key" ON "channel_inbound_events"("agent_channel_id", "event_id");

-- CreateIndex
CREATE INDEX "turns_source_event_id_idx" ON "turns"("source_event_id");

-- AddForeignKey
ALTER TABLE "channel_inbound_events" ADD CONSTRAINT "channel_inbound_events_agent_channel_id_fkey" FOREIGN KEY ("agent_channel_id") REFERENCES "agent_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
