-- CreateTable
CREATE TABLE "ssh_session" (
    "id" TEXT NOT NULL,
    "sandbox_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_email" TEXT NOT NULL,
    "source_ip" TEXT NOT NULL,
    "cert_serial" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attached_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "close_reason" TEXT,

    CONSTRAINT "ssh_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ssh_cert_mint" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ssh_cert_mint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ssh_session_sandbox_id_status_idx" ON "ssh_session"("sandbox_id", "status");

-- CreateIndex
CREATE INDEX "ssh_session_agent_id_status_idx" ON "ssh_session"("agent_id", "status");

-- CreateIndex
CREATE INDEX "ssh_cert_mint_user_id_agent_id_created_at_idx" ON "ssh_cert_mint"("user_id", "agent_id", "created_at");

-- CreateIndex
CREATE INDEX "ssh_cert_mint_created_at_idx" ON "ssh_cert_mint"("created_at");

-- AddForeignKey
ALTER TABLE "ssh_session" ADD CONSTRAINT "ssh_session_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
