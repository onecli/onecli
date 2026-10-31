-- CreateTable
CREATE TABLE "agent_sent_as_user" (
    "id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "user_token_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "channel_ref" TEXT NOT NULL,
    "message_ts" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_sent_as_user_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_sent_as_user_agent_id_user_token_id_idx" ON "agent_sent_as_user"("agent_id", "user_token_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_sent_as_user_channel_ref_message_ts_key" ON "agent_sent_as_user"("channel_ref", "message_ts");

-- AddForeignKey
ALTER TABLE "agent_sent_as_user" ADD CONSTRAINT "agent_sent_as_user_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "agent_read_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
