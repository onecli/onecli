-- CreateTable
CREATE TABLE "agent_send_as_preferences" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "recipient_ref" TEXT NOT NULL,
    "send_as" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_send_as_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_send_as_preferences_agent_id_user_id_recipient_ref_key" ON "agent_send_as_preferences"("agent_id", "user_id", "recipient_ref");

-- AddForeignKey
ALTER TABLE "agent_send_as_preferences" ADD CONSTRAINT "agent_send_as_preferences_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_send_as_preferences" ADD CONSTRAINT "agent_send_as_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
