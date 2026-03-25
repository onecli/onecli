/*
  Warnings:

  - Added the required column `user_email` to the `account_members` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `agent_secrets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `api_keys` table without a default value. This is not possible if the table is not empty.
  - Added the required column `user_email` to the `api_keys` table without a default value. This is not possible if the table is not empty.
  - Added the required column `user_email` to the `audit_logs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `onboarding_surveys` table without a default value. This is not possible if the table is not empty.
  - Added the required column `user_email` to the `onboarding_surveys` table without a default value. This is not possible if the table is not empty.
  - Added the required column `user_id` to the `onboarding_surveys` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "account_members" ADD COLUMN     "user_email" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "created_by_user_email" TEXT,
ADD COLUMN     "created_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "agent_secrets" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "created_by_user_id" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "updated_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "user_email" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "user_email" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "onboarding_surveys" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "user_email" TEXT NOT NULL,
ADD COLUMN     "user_id" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_secrets" ADD CONSTRAINT "agent_secrets_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_secrets" ADD CONSTRAINT "agent_secrets_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_surveys" ADD CONSTRAINT "onboarding_surveys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
