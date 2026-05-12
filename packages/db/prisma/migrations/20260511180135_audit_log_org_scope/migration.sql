-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_project_id_fkey";

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "organization_id" TEXT,
ALTER COLUMN "project_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
