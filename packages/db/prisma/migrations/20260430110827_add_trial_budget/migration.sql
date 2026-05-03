-- AlterTable
ALTER TABLE "request_logs" ADD COLUMN     "cache_creation_input_tokens" INTEGER,
ADD COLUMN     "cache_read_input_tokens" INTEGER,
ADD COLUMN     "cost_microcents" INTEGER,
ADD COLUMN     "input_tokens" INTEGER,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "output_tokens" INTEGER;

-- AlterTable
ALTER TABLE "secrets" ADD COLUMN     "is_platform" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "trial_budgets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "budget_cents" INTEGER NOT NULL DEFAULT 500,
    "spent_cents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trial_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trial_budgets_user_id_key" ON "trial_budgets"("user_id");

-- AddForeignKey
ALTER TABLE "trial_budgets" ADD CONSTRAINT "trial_budgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
