/*
  Warnings:

  - You are about to drop the column `audience` on the `agent_read_grants` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "agent_read_grants" DROP COLUMN "audience";
