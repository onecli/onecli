-- DropForeignKey
ALTER TABLE "partner_claims" DROP CONSTRAINT "partner_claims_placeholder_user_id_fkey";

-- AlterTable
ALTER TABLE "partner_claims" ALTER COLUMN "placeholder_user_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "partner_claims" ADD CONSTRAINT "partner_claims_placeholder_user_id_fkey" FOREIGN KEY ("placeholder_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
