-- AlterTable
ALTER TABLE "agent_channels" ADD COLUMN     "icon_checked_at" TIMESTAMP(3),
ADD COLUMN     "icon_synced_url" TEXT,
ADD COLUMN     "icon_url" TEXT;
