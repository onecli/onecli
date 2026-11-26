-- AlterTable
ALTER TABLE "channel_sent_messages" ADD COLUMN     "file_names" TEXT[] DEFAULT ARRAY[]::TEXT[];
