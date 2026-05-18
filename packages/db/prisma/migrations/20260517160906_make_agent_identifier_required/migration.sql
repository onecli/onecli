/*
  Warnings:

  - Made the column `identifier` on table `agents` required. This step will fail if there are existing NULL values in that column.

*/
-- Resolve conflicts first: if a non-default agent already has identifier="default",
-- rename it before we assign "default" to the actual default agent
UPDATE agents a SET identifier = 'default-' || LEFT(a.id, 8)
WHERE a.identifier = 'default' AND a.is_default = false
AND EXISTS (SELECT 1 FROM agents b WHERE b.project_id = a.project_id AND b.is_default = true AND b.identifier IS NULL);

-- Backfill: default agents get "default", any other null gets "agent-<first8chars-of-id>"
UPDATE agents SET identifier = 'default' WHERE identifier IS NULL AND is_default = true;
UPDATE agents SET identifier = 'agent-' || LEFT(id, 8) WHERE identifier IS NULL AND is_default = false;

-- AlterTable
ALTER TABLE "agents" ALTER COLUMN "identifier" SET NOT NULL;
