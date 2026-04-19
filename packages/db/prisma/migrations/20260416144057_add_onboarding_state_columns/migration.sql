-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "onboarding_completed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "onboarding_surveys" ADD COLUMN     "setup_state" JSONB;
