-- AlterTable
ALTER TABLE "onboarding_surveys" ADD COLUMN     "responses" JSONB NOT NULL DEFAULT '{}';
