-- DropIndex
DROP INDEX "partner_members_user_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "partner_members_user_id_key" ON "partner_members"("user_id");

