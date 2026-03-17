/*
  Warnings:

  - A unique constraint covering the columns `[userId,identifier]` on the table `Agent` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "identifier" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Agent_userId_identifier_key" ON "Agent"("userId", "identifier");
