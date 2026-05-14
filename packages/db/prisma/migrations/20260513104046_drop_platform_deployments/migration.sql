/*
  Warnings:

  - You are about to drop the `platform_deployments` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "platform_deployments" DROP CONSTRAINT "platform_deployments_project_id_fkey";

-- DropTable
DROP TABLE "platform_deployments";
