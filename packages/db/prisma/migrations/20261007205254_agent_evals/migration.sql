-- CreateTable
CREATE TABLE "agent_eval_questions" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "expected" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expected_apps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_eval_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_eval_runs" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "config_version" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "results" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "agent_eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_eval_questions_agent_id_archived_created_at_idx" ON "agent_eval_questions"("agent_id", "archived", "created_at");

-- CreateIndex
CREATE INDEX "agent_eval_runs_agent_id_created_at_idx" ON "agent_eval_runs"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_eval_runs_agent_id_status_idx" ON "agent_eval_runs"("agent_id", "status");

-- AddForeignKey
ALTER TABLE "agent_eval_questions" ADD CONSTRAINT "agent_eval_questions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
