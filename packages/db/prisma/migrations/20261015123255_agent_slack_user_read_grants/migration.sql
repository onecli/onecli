-- CreateTable
CREATE TABLE "agent_channel_user_tokens" (
    "id" TEXT NOT NULL,
    "agent_channel_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_channel_user_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_read_grants" (
    "id" TEXT NOT NULL,
    "user_token_id" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "subject_label" TEXT,
    "audience" TEXT NOT NULL DEFAULT 'granter_only',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_read_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_channel_user_tokens_agent_channel_id_external_user_id_idx" ON "agent_channel_user_tokens"("agent_channel_id", "external_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_channel_user_tokens_agent_channel_id_user_id_key" ON "agent_channel_user_tokens"("agent_channel_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_read_grants_user_token_id_external_ref_key" ON "agent_read_grants"("user_token_id", "external_ref");

-- AddForeignKey
ALTER TABLE "agent_channel_user_tokens" ADD CONSTRAINT "agent_channel_user_tokens_agent_channel_id_fkey" FOREIGN KEY ("agent_channel_id") REFERENCES "agent_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_channel_user_tokens" ADD CONSTRAINT "agent_channel_user_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_read_grants" ADD CONSTRAINT "agent_read_grants_user_token_id_fkey" FOREIGN KEY ("user_token_id") REFERENCES "agent_channel_user_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
