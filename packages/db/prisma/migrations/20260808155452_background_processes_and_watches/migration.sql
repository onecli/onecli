-- CreateTable
CREATE TABLE "sandbox_processes" (
    "id" TEXT NOT NULL,
    "sandbox_id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "container_ref" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "exit_code" INTEGER,
    "signal" TEXT,
    "tail" TEXT,
    "origin_conversation_id" TEXT,
    "created_by_user_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandbox_processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_watches" (
    "id" TEXT NOT NULL,
    "process_id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "pattern" TEXT,
    "silence_seconds" INTEGER,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'armed',
    "trigger" TEXT,
    "excerpt" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "triggered_at" TIMESTAMP(3),
    "fired_at" TIMESTAMP(3),
    "fire_claimed_at" TIMESTAMP(3),
    "origin_conversation_id" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "process_watches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sandbox_processes_sandbox_id_status_idx" ON "sandbox_processes"("sandbox_id", "status");

-- CreateIndex
CREATE INDEX "sandbox_processes_status_idx" ON "sandbox_processes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_processes_sandbox_id_ref_key" ON "sandbox_processes"("sandbox_id", "ref");

-- CreateIndex
CREATE INDEX "process_watches_process_id_status_idx" ON "process_watches"("process_id", "status");

-- CreateIndex
CREATE INDEX "process_watches_status_expires_at_idx" ON "process_watches"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "process_watches_process_id_ref_key" ON "process_watches"("process_id", "ref");

-- AddForeignKey
ALTER TABLE "sandbox_processes" ADD CONSTRAINT "sandbox_processes_sandbox_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_processes" ADD CONSTRAINT "sandbox_processes_origin_conversation_id_fkey" FOREIGN KEY ("origin_conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_processes" ADD CONSTRAINT "sandbox_processes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_watches" ADD CONSTRAINT "process_watches_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "sandbox_processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_watches" ADD CONSTRAINT "process_watches_origin_conversation_id_fkey" FOREIGN KEY ("origin_conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_watches" ADD CONSTRAINT "process_watches_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Hand-appended (Prisma cannot express these) ──────────────────────────────
-- kind names its payload and nothing else may (the coherence-equality idiom;
-- "exit" carries neither).
ALTER TABLE "process_watches"
  ADD CONSTRAINT "process_watches_kind_coherent"
  CHECK (
    (("kind" = 'pattern') = ("pattern" IS NOT NULL))
    AND (("kind" = 'silence') = ("silence_seconds" IS NOT NULL))
  );

-- A trigger (and its timestamp) exists exactly on the states that mean "the
-- condition happened"; fired always says when.
ALTER TABLE "process_watches"
  ADD CONSTRAINT "process_watches_status_coherent"
  CHECK (
    (("status" IN ('triggered', 'fired')) = ("trigger" IS NOT NULL))
    AND (("status" IN ('triggered', 'fired')) = ("triggered_at" IS NOT NULL))
    AND (("status" = 'fired') = ("fired_at" IS NOT NULL))
  );

-- A terminal process always says when it ended; a running one never does.
ALTER TABLE "sandbox_processes"
  ADD CONSTRAINT "sandbox_processes_ended_coherent"
  CHECK (("status" IN ('exited', 'stopped', 'lost')) = ("ended_at" IS NOT NULL));
