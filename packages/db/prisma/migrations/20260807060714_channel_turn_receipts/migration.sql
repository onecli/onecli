-- CreateTable
CREATE TABLE "channel_turn_receipts" (
    "id" TEXT NOT NULL,
    "turn_id" TEXT NOT NULL,
    "agent_channel_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "message_ts" TEXT NOT NULL,
    "reaction" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_turn_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_turn_receipts_turn_id_key" ON "channel_turn_receipts"("turn_id");

-- AddForeignKey
ALTER TABLE "channel_turn_receipts" ADD CONSTRAINT "channel_turn_receipts_agent_channel_id_fkey" FOREIGN KEY ("agent_channel_id") REFERENCES "agent_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
