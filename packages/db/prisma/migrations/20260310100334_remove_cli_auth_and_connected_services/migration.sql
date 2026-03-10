/*
  Warnings:

  - You are about to drop the `CliAuthSession` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ConnectedService` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "ConnectedService" DROP CONSTRAINT "ConnectedService_userId_fkey";

-- DropTable
DROP TABLE "CliAuthSession";

-- DropTable
DROP TABLE "ConnectedService";
