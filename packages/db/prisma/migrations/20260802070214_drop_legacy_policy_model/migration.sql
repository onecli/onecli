-- DEPLOY NOTE (destructive): this drops columns the PREVIOUSLY deployed
-- api-server still selects (agents.secret_mode). Migrations run from the web
-- entrypoint only, and deploy.yml exposes web/gateway/api-server as
-- independent checkboxes — this migration must ship in a SINGLE deploy run
-- with ALL THREE services checked. Old tasks draining during the rollout may
-- error briefly on the dropped column; that window was accepted explicitly
-- (see plans/ee-overlay-dissolution.md, decision 7).
/*
  Warnings:

  - You are about to drop the column `secret_mode` on the `agents` table. All the data in the column will be lost.
  - You are about to drop the column `policy_mode` on the `organizations` table. All the data in the column will be lost.
  - You are about to drop the `agent_app_connections` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `agent_secrets` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `policy_rules` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "agent_app_connections" DROP CONSTRAINT "agent_app_connections_agent_id_fkey";

-- DropForeignKey
ALTER TABLE "agent_app_connections" DROP CONSTRAINT "agent_app_connections_app_connection_id_fkey";

-- DropForeignKey
ALTER TABLE "agent_secrets" DROP CONSTRAINT "agent_secrets_agent_id_fkey";

-- DropForeignKey
ALTER TABLE "agent_secrets" DROP CONSTRAINT "agent_secrets_created_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "agent_secrets" DROP CONSTRAINT "agent_secrets_secret_id_fkey";

-- DropForeignKey
ALTER TABLE "agent_secrets" DROP CONSTRAINT "agent_secrets_updated_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "policy_rules" DROP CONSTRAINT "policy_rules_agent_id_fkey";

-- DropForeignKey
ALTER TABLE "policy_rules" DROP CONSTRAINT "policy_rules_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "policy_rules" DROP CONSTRAINT "policy_rules_partner_id_fkey";

-- DropForeignKey
ALTER TABLE "policy_rules" DROP CONSTRAINT "policy_rules_project_id_fkey";

-- AlterTable
ALTER TABLE "agents" DROP COLUMN "secret_mode";

-- AlterTable
ALTER TABLE "organizations" DROP COLUMN "policy_mode";

-- DropTable
DROP TABLE "agent_app_connections";

-- DropTable
DROP TABLE "agent_secrets";

-- DropTable
DROP TABLE "policy_rules";
