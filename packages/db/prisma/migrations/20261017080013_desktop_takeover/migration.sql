-- AlterTable
ALTER TABLE "sandbox_ports" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'preview';

-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN     "desktop_viewable" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "desktop_sessions" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "controller_user_id" TEXT,
    "control_taken_at" TIMESTAMP(3),
    "control_expires_at" TIMESTAMP(3),
    "control_pushed_at" TIMESTAMP(3),
    "request_id" TEXT,
    "request_reason" TEXT,
    "requested_at" TIMESTAMP(3),
    "request_conversation_id" TEXT,
    "request_turn_id" TEXT,
    "request_card_refs" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "desktop_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "desktop_sessions_agent_id_key" ON "desktop_sessions"("agent_id");

-- CreateIndex
CREATE INDEX "desktop_sessions_workspace_id_idx" ON "desktop_sessions"("workspace_id");

-- CreateIndex
CREATE INDEX "desktop_sessions_control_expires_at_idx" ON "desktop_sessions"("control_expires_at");

-- AddForeignKey
ALTER TABLE "desktop_sessions" ADD CONSTRAINT "desktop_sessions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desktop_sessions" ADD CONSTRAINT "desktop_sessions_controller_user_id_fkey" FOREIGN KEY ("controller_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
