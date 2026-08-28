-- CreateTable
CREATE TABLE "agent_memories" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "content" TEXT NOT NULL,
    "last_revision_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_memory_revisions" (
    "id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "op" TEXT NOT NULL,
    "restored_from_seq" INTEGER,
    "title" TEXT,
    "description" TEXT,
    "content" TEXT NOT NULL,
    "author_kind" TEXT NOT NULL,
    "author_user_id" TEXT,
    "author_email" TEXT,
    "conversation_id" TEXT,
    "turn_id" TEXT,
    "redacted_at" TIMESTAMP(3),
    "redacted_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_memory_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_memories_agent_id_key_key" ON "agent_memories"("agent_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "agent_memory_revisions_memory_id_seq_key" ON "agent_memory_revisions"("memory_id", "seq");

-- AddForeignKey
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory_revisions" ADD CONSTRAINT "agent_memory_revisions_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "agent_memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory_revisions" ADD CONSTRAINT "agent_memory_revisions_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory_revisions" ADD CONSTRAINT "agent_memory_revisions_redacted_by_user_id_fkey" FOREIGN KEY ("redacted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Hand-appended (Prisma cannot express these) ──────────────────────────────
-- A restore always names what it restored, and nothing else may (the
-- coherence-equality idiom, same family as agents_model_override_coherent).
-- Fresh table — nothing existing to violate.
ALTER TABLE "agent_memory_revisions"
  ADD CONSTRAINT "agent_memory_revisions_restore_coherent"
  CHECK (("op" = 'restore') = ("restored_from_seq" IS NOT NULL));

-- A redactor stamp implies a redaction time. ONE-WAY on purpose: the reverse
-- must stay legal because redacted_by_user_id is SetNull — a redaction
-- outlives its redactor.
ALTER TABLE "agent_memory_revisions"
  ADD CONSTRAINT "agent_memory_revisions_redaction_coherent"
  CHECK ("redacted_by_user_id" IS NULL OR "redacted_at" IS NOT NULL);
