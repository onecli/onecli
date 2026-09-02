-- AlterTable
ALTER TABLE "turns" ADD COLUMN     "ceiling_warned_at" TIMESTAMP(3),
ADD COLUMN     "last_progress_at" TIMESTAMP(3);
