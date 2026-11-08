/*
  Drop the old outbound address book (`agent_contacts`). Nothing reads it
  any more: a person's and a channel's ONE setting is their reach row.
  Runs after 20261021152930_one_person_setting, which folded every decision
  here (allow and blocked) into those rows; `ask` rows were never a decision.

  Deploy note: the migration runs before the services roll, so the
  previous release's reads of this table fail until the new servers are up.
  Accepted for this change.
*/
-- DropForeignKey
ALTER TABLE "agent_contacts" DROP CONSTRAINT "agent_contacts_agent_id_fkey";

-- DropForeignKey
ALTER TABLE "agent_contacts" DROP CONSTRAINT "agent_contacts_decided_by_user_id_fkey";

-- DropTable
DROP TABLE "agent_contacts";
