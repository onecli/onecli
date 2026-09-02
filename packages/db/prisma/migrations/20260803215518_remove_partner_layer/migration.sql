/*
  Warnings:

  - You are about to drop the column `partner_id` on the `app_configs` table. All the data in the column will be lost.
  - You are about to drop the column `partner_id` on the `app_connections` table. All the data in the column will be lost.
  - You are about to drop the column `partner_detached_at` on the `organizations` table. All the data in the column will be lost.
  - You are about to drop the column `partner_id` on the `organizations` table. All the data in the column will be lost.
  - You are about to drop the column `partner_id` on the `secrets` table. All the data in the column will be lost.
  - You are about to drop the `partner_claims` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `partner_members` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `partners` table. If the table is not empty, all the data it contains will be lost.

*/

-- ── Data cleanup (hand-written; runs before the schema drops) ───────────────
--
-- 1. UNCLAIMED partner orgs (any partner_claims row that never reached
--    'claimed' — 'pending', or a hypothetical 'expired') are owned by a
--    placeholder user that can never sign in; with the claim flow removed they
--    would be permanently unreachable. Delete them, their content, and their
--    placeholder owners. The delete order mirrors the app-level single source
--    of truth for the child graphs: `deleteProjectContent` and
--    `deleteOrganizationContent` (packages/api), plus `deletePlaceholderUser`
--    for the per-user rows.
-- 2. Partner-scoped secrets lose their producer. Delete them and their
--    metering rows: `budgets` cascades via its secret FK, but `budget_spends`
--    has NO foreign keys and needs an explicit delete.
--
-- Claimed partner orgs are untouched: they keep a real owner and simply stop
-- inheriting partner secrets (their partner linkage columns drop below).

DO $cleanup$
BEGIN
  -- Skip the whole teardown when there is nothing to tear down (every
  -- partner-free database — self-host, dev, and prod once the claim queue is
  -- empty). The per-user audit_logs delete below has no supporting index, so
  -- it must not run as a full-table scan on databases with no zombies.
  IF NOT EXISTS (SELECT 1 FROM "partner_claims" WHERE "status" <> 'claimed') THEN
    RETURN;
  END IF;

  CREATE TEMPORARY TABLE "zombie_orgs" AS
    SELECT "organization_id" AS "id" FROM "partner_claims" WHERE "status" <> 'claimed';
  CREATE TEMPORARY TABLE "zombie_users" AS
    SELECT "placeholder_user_id" AS "id" FROM "partner_claims"
     WHERE "status" <> 'claimed' AND "placeholder_user_id" IS NOT NULL;
  CREATE TEMPORARY TABLE "zombie_projects" AS
    SELECT "id" FROM "projects"
     WHERE "organization_id" IN (SELECT "id" FROM "zombie_orgs");
  -- CTAS collects no statistics and autovacuum never visits temp tables;
  -- without ANALYZE the planner guesses hundreds of rows and may seq-scan
  -- request_logs/audit_logs instead of using their (project_id, …) indexes.
  ANALYZE "zombie_orgs";
  ANALYZE "zombie_users";
  ANALYZE "zombie_projects";

  -- Project children (deleteProjectContent order).
  DELETE FROM "request_logs" WHERE "project_id" IN (SELECT "id" FROM "zombie_projects");
  DELETE FROM "agents" WHERE "project_id" IN (SELECT "id" FROM "zombie_projects");
  DELETE FROM "app_connections" WHERE "project_id" IN (SELECT "id" FROM "zombie_projects");
  DELETE FROM "secrets" WHERE "project_id" IN (SELECT "id" FROM "zombie_projects");
  DELETE FROM "app_configs" WHERE "project_id" IN (SELECT "id" FROM "zombie_projects");
  DELETE FROM "vault_connections" WHERE "project_id" IN (SELECT "id" FROM "zombie_projects");
  DELETE FROM "onboarding_surveys" WHERE "project_id" IN (SELECT "id" FROM "zombie_projects");
  DELETE FROM "audit_logs" WHERE "project_id" IN (SELECT "id" FROM "zombie_projects");
  DELETE FROM "api_keys" WHERE "project_id" IN (SELECT "id" FROM "zombie_projects");
  DELETE FROM "projects" WHERE "id" IN (SELECT "id" FROM "zombie_projects");

  -- Org children (deleteOrganizationContent order; partner_claims included —
  -- its RESTRICT FK on organizations is still live at this point).
  DELETE FROM "audit_logs" WHERE "organization_id" IN (SELECT "id" FROM "zombie_orgs");
  DELETE FROM "secrets" WHERE "organization_id" IN (SELECT "id" FROM "zombie_orgs");
  DELETE FROM "api_keys" WHERE "organization_id" IN (SELECT "id" FROM "zombie_orgs");
  DELETE FROM "app_configs" WHERE "organization_id" IN (SELECT "id" FROM "zombie_orgs");
  DELETE FROM "app_connections" WHERE "organization_id" IN (SELECT "id" FROM "zombie_orgs");
  DELETE FROM "invitations" WHERE "organization_id" IN (SELECT "id" FROM "zombie_orgs");
  DELETE FROM "user_provisions" WHERE "organization_id" IN (SELECT "id" FROM "zombie_orgs");
  DELETE FROM "budgets" WHERE "organization_id" IN (SELECT "id" FROM "zombie_orgs");
  DELETE FROM "budget_spends" WHERE "organization_id" IN (SELECT "id" FROM "zombie_orgs");
  DELETE FROM "partner_claims" WHERE "organization_id" IN (SELECT "id" FROM "zombie_orgs");
  DELETE FROM "organization_members" WHERE "organization_id" IN (SELECT "id" FROM "zombie_orgs");
  DELETE FROM "organizations" WHERE "id" IN (SELECT "id" FROM "zombie_orgs");

  -- Placeholder owners (deletePlaceholderUser: the rows that always die with
  -- the user; their transferable children were deleted with the org above).
  DELETE FROM "onboarding_surveys" WHERE "user_id" IN (SELECT "id" FROM "zombie_users");
  DELETE FROM "audit_logs" WHERE "user_id" IN (SELECT "id" FROM "zombie_users");
  DELETE FROM "users" WHERE "id" IN (SELECT "id" FROM "zombie_users");

  DROP TABLE "zombie_projects";
  DROP TABLE "zombie_users";
  DROP TABLE "zombie_orgs";
END
$cleanup$;

-- Partner-scoped secrets and their metering rows, claimed partners included
-- (budgets cascades on the secret FK; budget_spends has no FK — explicit).
-- Both predicates are index-served (budget_spends PK leads on secret_id;
-- secrets has the scope index), so this stays cheap on partner-free databases.
DELETE FROM "budget_spends" WHERE "secret_id" IN
  (SELECT "id" FROM "secrets" WHERE "scope" = 'partner');
DELETE FROM "secrets" WHERE "scope" = 'partner';

-- DropForeignKey
ALTER TABLE "app_configs" DROP CONSTRAINT "app_configs_partner_id_fkey";

-- DropForeignKey
ALTER TABLE "app_connections" DROP CONSTRAINT "app_connections_partner_id_fkey";

-- DropForeignKey
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_partner_id_fkey";

-- DropForeignKey
ALTER TABLE "partner_claims" DROP CONSTRAINT "partner_claims_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "partner_claims" DROP CONSTRAINT "partner_claims_partner_id_fkey";

-- DropForeignKey
ALTER TABLE "partner_claims" DROP CONSTRAINT "partner_claims_placeholder_user_id_fkey";

-- DropForeignKey
ALTER TABLE "partner_members" DROP CONSTRAINT "partner_members_partner_id_fkey";

-- DropForeignKey
ALTER TABLE "partner_members" DROP CONSTRAINT "partner_members_user_id_fkey";

-- DropForeignKey
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_partner_id_fkey";

-- DropIndex
DROP INDEX "app_configs_partner_id_idx";

-- DropIndex
DROP INDEX "app_connections_partner_id_idx";

-- DropIndex
DROP INDEX "organizations_partner_id_idx";

-- DropIndex
DROP INDEX "secrets_partner_id_idx";

-- AlterTable
ALTER TABLE "app_configs" DROP COLUMN "partner_id";

-- AlterTable
ALTER TABLE "app_connections" DROP COLUMN "partner_id";

-- AlterTable
ALTER TABLE "organizations" DROP COLUMN "partner_detached_at",
DROP COLUMN "partner_id";

-- AlterTable
ALTER TABLE "secrets" DROP COLUMN "partner_id";

-- DropTable
DROP TABLE "partner_claims";

-- DropTable
DROP TABLE "partner_members";

-- DropTable
DROP TABLE "partners";
