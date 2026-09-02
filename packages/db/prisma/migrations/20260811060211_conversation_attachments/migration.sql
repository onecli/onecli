-- CreateTable
CREATE TABLE "conversation_attachments" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "turn_id" TEXT,
    "user_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'web',
    "name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA,
    "storage_ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_attachments_conversation_id_created_at_idx" ON "conversation_attachments"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "conversation_attachments_turn_id_idx" ON "conversation_attachments"("turn_id");

-- CreateIndex
CREATE INDEX "conversation_attachments_status_created_at_idx" ON "conversation_attachments"("status", "created_at");

-- AddForeignKey
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
