-- AlterTable
ALTER TABLE "channel_turn_receipts" ADD COLUMN     "card_at" TIMESTAMP(3),
ADD COLUMN     "card_rev" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "card_steps" TEXT[],
ADD COLUMN     "card_thread_ts" TEXT,
ADD COLUMN     "card_ts" TEXT,
ADD COLUMN     "seen_message_ts" TEXT,
ADD COLUMN     "work_status_set" BOOLEAN NOT NULL DEFAULT false;
