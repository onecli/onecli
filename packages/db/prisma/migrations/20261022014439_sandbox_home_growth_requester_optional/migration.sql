-- DropForeignKey
ALTER TABLE "sandbox_home_growth_operations" DROP CONSTRAINT "sandbox_home_growth_operations_requested_by_user_id_fkey";

-- AlterTable
ALTER TABLE "sandbox_home_growth_operations" ALTER COLUMN "requested_by_user_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "sandbox_home_growth_operations" ADD CONSTRAINT "sandbox_home_growth_operations_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
