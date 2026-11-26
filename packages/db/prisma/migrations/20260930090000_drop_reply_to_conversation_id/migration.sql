/*
  Warnings:

  - You are about to drop the column `reply_to_conversation_id` on the `conversations` table. All the data in the column will be lost.

  Safe to drop: superseded by `PeerTask.homeConversationId` (one row per
  task instead of one slot per pair). Unread and unwritten since the peer
  tasks migration (20260917201600_peer_tasks) shipped, and null on every
  row written since, so nothing depends on its contents.

*/
-- AlterTable
ALTER TABLE "conversations" DROP COLUMN "reply_to_conversation_id";
