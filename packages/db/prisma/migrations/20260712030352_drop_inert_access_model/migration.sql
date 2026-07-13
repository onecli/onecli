/*
  Warnings:

  - You are about to drop the column `app_mode` on the `agent_groups` table. All the data in the column will be lost.
  - You are about to drop the column `credential_mode` on the `agent_groups` table. All the data in the column will be lost.
  - You are about to drop the column `access_mode` on the `app_connections` table. All the data in the column will be lost.
  - You are about to drop the column `app_mode` on the `groups` table. All the data in the column will be lost.
  - You are about to drop the column `agent_group_id` on the `policy_rules` table. All the data in the column will be lost.
  - You are about to drop the column `group_id` on the `policy_rules` table. All the data in the column will be lost.
  - You are about to drop the column `access_mode` on the `secrets` table. All the data in the column will be lost.
  - You are about to drop the `app_access` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `connection_access` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `secret_access` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "app_access" DROP CONSTRAINT "app_access_agent_group_id_fkey";

-- DropForeignKey
ALTER TABLE "app_access" DROP CONSTRAINT "app_access_agent_id_fkey";

-- DropForeignKey
ALTER TABLE "app_access" DROP CONSTRAINT "app_access_created_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "app_access" DROP CONSTRAINT "app_access_group_id_fkey";

-- DropForeignKey
ALTER TABLE "app_access" DROP CONSTRAINT "app_access_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "app_access" DROP CONSTRAINT "app_access_user_id_fkey";

-- DropForeignKey
ALTER TABLE "connection_access" DROP CONSTRAINT "connection_access_agent_group_id_fkey";

-- DropForeignKey
ALTER TABLE "connection_access" DROP CONSTRAINT "connection_access_agent_id_fkey";

-- DropForeignKey
ALTER TABLE "connection_access" DROP CONSTRAINT "connection_access_app_connection_id_fkey";

-- DropForeignKey
ALTER TABLE "connection_access" DROP CONSTRAINT "connection_access_created_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "connection_access" DROP CONSTRAINT "connection_access_group_id_fkey";

-- DropForeignKey
ALTER TABLE "connection_access" DROP CONSTRAINT "connection_access_user_id_fkey";

-- DropForeignKey
ALTER TABLE "policy_rules" DROP CONSTRAINT "policy_rules_agent_group_id_fkey";

-- DropForeignKey
ALTER TABLE "policy_rules" DROP CONSTRAINT "policy_rules_group_id_fkey";

-- DropForeignKey
ALTER TABLE "secret_access" DROP CONSTRAINT "secret_access_agent_group_id_fkey";

-- DropForeignKey
ALTER TABLE "secret_access" DROP CONSTRAINT "secret_access_agent_id_fkey";

-- DropForeignKey
ALTER TABLE "secret_access" DROP CONSTRAINT "secret_access_created_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "secret_access" DROP CONSTRAINT "secret_access_group_id_fkey";

-- DropForeignKey
ALTER TABLE "secret_access" DROP CONSTRAINT "secret_access_secret_id_fkey";

-- DropForeignKey
ALTER TABLE "secret_access" DROP CONSTRAINT "secret_access_user_id_fkey";

-- DropIndex
DROP INDEX "policy_rules_agent_group_id_idx";

-- DropIndex
DROP INDEX "policy_rules_group_id_idx";

-- AlterTable
ALTER TABLE "agent_groups" DROP COLUMN "app_mode",
DROP COLUMN "credential_mode";

-- AlterTable
ALTER TABLE "app_connections" DROP COLUMN "access_mode";

-- AlterTable
ALTER TABLE "groups" DROP COLUMN "app_mode";

-- AlterTable
ALTER TABLE "policy_rules" DROP COLUMN "agent_group_id",
DROP COLUMN "group_id";

-- AlterTable
ALTER TABLE "secrets" DROP COLUMN "access_mode";

-- DropTable
DROP TABLE "app_access";

-- DropTable
DROP TABLE "connection_access";

-- DropTable
DROP TABLE "secret_access";
