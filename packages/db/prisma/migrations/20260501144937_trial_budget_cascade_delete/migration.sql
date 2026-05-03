-- DropForeignKey
ALTER TABLE "trial_budgets" DROP CONSTRAINT "trial_budgets_user_id_fkey";

-- AddForeignKey
ALTER TABLE "trial_budgets" ADD CONSTRAINT "trial_budgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
