-- CreateTable
CREATE TABLE "channel_sent_messages" (
    "id" TEXT NOT NULL,
    "agent_channel_id" TEXT NOT NULL,
    "external_thread_id" TEXT NOT NULL,
    "recipient_label" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "origin_conversation_id" TEXT,
    "origin_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_sent_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_sent_messages_agent_channel_id_external_thread_id_c_idx" ON "channel_sent_messages"("agent_channel_id", "external_thread_id", "created_at");

-- AddForeignKey
ALTER TABLE "channel_sent_messages" ADD CONSTRAINT "channel_sent_messages_agent_channel_id_fkey" FOREIGN KEY ("agent_channel_id") REFERENCES "agent_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sent_messages" ADD CONSTRAINT "channel_sent_messages_origin_conversation_id_fkey" FOREIGN KEY ("origin_conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sent_messages" ADD CONSTRAINT "channel_sent_messages_origin_user_id_fkey" FOREIGN KEY ("origin_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
