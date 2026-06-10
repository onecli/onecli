-- CreateTable
CREATE TABLE "budgets" (
    "id" TEXT NOT NULL,
    "secret_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "project_id" TEXT,
    "limit_cents" INTEGER NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'monthly',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_spends" (
    "secret_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "spent_nanos" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_spends_pkey" PRIMARY KEY ("secret_id","organization_id","period")
);

-- CreateIndex
CREATE INDEX "budgets_secret_id_idx" ON "budgets"("secret_id");

-- CreateIndex
CREATE INDEX "budgets_organization_id_idx" ON "budgets"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_secret_id_organization_id_key" ON "budgets"("secret_id", "organization_id");

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

