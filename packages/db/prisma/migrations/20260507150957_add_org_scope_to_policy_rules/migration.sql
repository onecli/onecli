-- DropForeignKey
ALTER TABLE "policy_rules" DROP CONSTRAINT "policy_rules_project_id_fkey";

-- AlterTable
ALTER TABLE "policy_rules" ADD COLUMN     "organization_id" TEXT,
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'project',
ALTER COLUMN "project_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "policy_rules_organization_id_idx" ON "policy_rules"("organization_id");

-- CreateIndex
CREATE INDEX "policy_rules_scope_idx" ON "policy_rules"("scope");

-- AddForeignKey
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
