-- AlterTable
ALTER TABLE "turns" ADD COLUMN     "follow_up_of_turn_id" TEXT,
ADD COLUMN     "promoted_at" TIMESTAMP(3),
ADD COLUMN     "steer_delivered_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "turns_follow_up_of_turn_id_idx" ON "turns"("follow_up_of_turn_id");
