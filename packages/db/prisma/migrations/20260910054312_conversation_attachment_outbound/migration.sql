-- AlterTable
ALTER TABLE "conversation_attachments" ADD COLUMN     "caption" TEXT,
ADD COLUMN     "direction" TEXT NOT NULL DEFAULT 'inbound';

-- CreateIndex
CREATE INDEX "conversation_attachments_conversation_id_direction_created__idx" ON "conversation_attachments"("conversation_id", "direction", "created_at");
