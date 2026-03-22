-- AlterTable
ALTER TABLE "policy_rule" ADD COLUMN     "rate_limit" INTEGER,
ADD COLUMN     "rate_limit_window" TEXT;
