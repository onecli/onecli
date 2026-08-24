-- CreateIndex
CREATE INDEX "ssh_session_status_last_heartbeat_at_idx" ON "ssh_session"("status", "last_heartbeat_at");
