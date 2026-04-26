-- CreateTable
CREATE TABLE "request_logs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "injection_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "request_logs_account_id_created_at_idx" ON "request_logs"("account_id", "created_at");
