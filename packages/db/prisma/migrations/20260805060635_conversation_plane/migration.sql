-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'web',
    "external_ref" TEXT,
    "title" TEXT,
    "harness_session_ref" TEXT,
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "turns" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "message" TEXT NOT NULL,
    "abort_requested" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "usage" JSONB,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "turn_events" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "turn_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "turn_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_agent_id_created_at_idx" ON "conversations"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "conversations_agent_id_source_external_ref_idx" ON "conversations"("agent_id", "source", "external_ref");

-- CreateIndex
CREATE INDEX "turns_conversation_id_created_at_idx" ON "turns"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "turns_status_updated_at_idx" ON "turns"("status", "updated_at");

-- CreateIndex
CREATE INDEX "turn_events_turn_id_seq_idx" ON "turn_events"("turn_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "turn_events_conversation_id_seq_key" ON "turn_events"("conversation_id", "seq");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turns" ADD CONSTRAINT "turns_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turn_events" ADD CONSTRAINT "turn_events_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turn_events" ADD CONSTRAINT "turn_events_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-appended (Prisma's @@unique has no WHERE clause): at most one ACTIVE
-- turn per conversation — the database backstop behind the app-layer check,
-- and what makes "you cannot send a second message while the agent is working"
-- a law rather than a UI convention. Transitions within the active set are
-- single-row UPDATEs, so they cannot overlap.
--
-- Deliberately NOT declared as @@unique in schema.prisma: Prisma 6's differ
-- ignores the WHERE clause and would fight it (endless recreate). It is
-- invisible to drift here because the Postgres describer filters partial
-- indexes (`indpred IS NULL`) — the same reason this repo's hand-appended
-- CHECK constraints survive `migrate dev`.
--
-- UPGRADE LANDMINE: Prisma >= 7.4 introspects partial indexes and will emit a
-- DROP INDEX for one it cannot find in the schema. That upgrade must move this
-- into PSL (`@@unique([...], where: ...)`, partialIndexes preview) in the same
-- change. See plans/hosted-agents-v2.md step 4.
CREATE UNIQUE INDEX "turns_one_active_per_conversation"
  ON "turns" ("conversation_id")
  WHERE "status" IN ('queued', 'dispatched', 'running');
