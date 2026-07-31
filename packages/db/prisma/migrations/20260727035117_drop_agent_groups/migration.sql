/*
  Warnings:

  - You are about to drop the column `agent_group_id` on the `policy_rule_identities` table. All the data in the column will be lost.
  - You are about to drop the `agent_group_members` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `agent_groups` table. If the table is not empty, all the data it contains will be lost.
*/

-- Agent groups are removed as a feature. No agent-group rows exist in any
-- managed environment; the deletes below are defensive so the migration is
-- correct on ANY database (e.g. a self-hosted install that used them).

-- A rule whose ONLY identities were agent-groups must not survive the column
-- drop: with its identity rows gone it would read as "any identity" and
-- silently widen to every agent. Delete the whole rule instead (its identity
-- rows cascade).
DELETE FROM "policy_rules_v2" r
WHERE EXISTS (
  SELECT 1 FROM "policy_rule_identities" i
  WHERE i."rule_id" = r."id" AND i."agent_group_id" IS NOT NULL
)
AND NOT EXISTS (
  SELECT 1 FROM "policy_rule_identities" i
  WHERE i."rule_id" = r."id" AND i."agent_group_id" IS NULL
);

-- Mixed-identity rules keep their other principals; only the agent-group
-- rows go (required before the one_principal CHECK is re-added, since these
-- rows have every surviving principal column NULL).
DELETE FROM "policy_rule_identities" WHERE "agent_group_id" IS NOT NULL;

-- The 4-column one_principal CHECK references agent_group_id; drop it
-- explicitly before the column (PostgreSQL would drop it implicitly with the
-- column) and re-add the 3-column form at the end.
ALTER TABLE "policy_rule_identities" DROP CONSTRAINT "policy_rule_identities_one_principal";

-- DropForeignKey
ALTER TABLE "agent_group_members" DROP CONSTRAINT "agent_group_members_agent_group_id_fkey";

-- DropForeignKey
ALTER TABLE "agent_group_members" DROP CONSTRAINT "agent_group_members_agent_id_fkey";

-- DropForeignKey
ALTER TABLE "agent_group_members" DROP CONSTRAINT "agent_group_members_created_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "agent_groups" DROP CONSTRAINT "agent_groups_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "policy_rule_identities" DROP CONSTRAINT "policy_rule_identities_agent_group_id_fkey";

-- DropIndex
DROP INDEX "policy_rule_identities_agent_group_id_idx";

-- DropIndex
DROP INDEX "policy_rule_identities_rule_id_agent_group_id_key";

-- AlterTable
ALTER TABLE "policy_rule_identities" DROP COLUMN "agent_group_id";

-- DropTable
DROP TABLE "agent_group_members";

-- DropTable
DROP TABLE "agent_groups";

-- Exactly one of the three surviving principal columns per identity row
-- (replaces the 4-column form dropped above).
ALTER TABLE "policy_rule_identities" ADD CONSTRAINT "policy_rule_identities_one_principal"
  CHECK (num_nonnulls("agent_id", "user_id", "group_id") = 1);
