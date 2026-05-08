/*
  Warnings:

  - A unique constraint covering the columns `[organization_id,provider]` on the table `app_configs` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "app_configs" DROP CONSTRAINT "app_configs_project_id_fkey";

-- DropForeignKey
ALTER TABLE "app_connections" DROP CONSTRAINT "app_connections_project_id_fkey";

-- DropForeignKey
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_project_id_fkey";

-- AlterTable
ALTER TABLE "app_configs" ADD COLUMN     "organization_id" TEXT,
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'project',
ALTER COLUMN "project_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "app_connections" ADD COLUMN     "organization_id" TEXT,
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'project',
ALTER COLUMN "project_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "secrets" ADD COLUMN     "organization_id" TEXT,
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'project',
ALTER COLUMN "project_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "app_configs_scope_idx" ON "app_configs"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "app_configs_organization_id_provider_key" ON "app_configs"("organization_id", "provider");

-- CreateIndex
CREATE INDEX "app_connections_organization_id_provider_idx" ON "app_connections"("organization_id", "provider");

-- CreateIndex
CREATE INDEX "app_connections_scope_idx" ON "app_connections"("scope");

-- CreateIndex
CREATE INDEX "secrets_organization_id_idx" ON "secrets"("organization_id");

-- CreateIndex
CREATE INDEX "secrets_scope_idx" ON "secrets"("scope");

-- AddForeignKey
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_configs" ADD CONSTRAINT "app_configs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_configs" ADD CONSTRAINT "app_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
