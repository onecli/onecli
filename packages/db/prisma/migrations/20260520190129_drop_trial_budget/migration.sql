/*
  Warnings:

  - You are about to drop the `trial_budgets` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "trial_budgets" DROP CONSTRAINT "trial_budgets_user_id_fkey";

-- DropTable
DROP TABLE "trial_budgets";
