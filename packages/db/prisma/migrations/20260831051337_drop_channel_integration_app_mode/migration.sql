/*
  Warnings:

  - You are about to drop the column `app_mode` on the `channel_integrations` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "channel_integrations" DROP COLUMN "app_mode";
