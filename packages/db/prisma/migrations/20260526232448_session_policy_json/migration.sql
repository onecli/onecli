/*
  Warnings:

  - The `session_policy` column on the `agent_app_connections` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "agent_app_connections" DROP COLUMN "session_policy",
ADD COLUMN     "session_policy" JSONB;
