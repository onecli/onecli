/*
  Warnings:

  - You are about to drop the column `apiKey` on the `CliAuthSession` table. All the data in the column will be lost.
  - You are about to drop the column `apiKey` on the `User` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "User_apiKey_key";

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CliAuthSession" DROP COLUMN "apiKey",
ADD COLUMN     "agentToken" TEXT;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "apiKey";
