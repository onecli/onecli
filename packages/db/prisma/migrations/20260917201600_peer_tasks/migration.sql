-- CreateTable
CREATE TABLE "peer_tasks" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "peer_agent_id" TEXT NOT NULL,
    "pair_a_id" TEXT NOT NULL,
    "pair_b_id" TEXT NOT NULL,
    "home_conversation_id" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "ask" TEXT NOT NULL,
    "opener" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "agent_sent" INTEGER NOT NULL DEFAULT 0,
    "peer_sent" INTEGER NOT NULL DEFAULT 0,
    "awaiting_peer" BOOLEAN NOT NULL DEFAULT false,
    "last_peer_text" TEXT,
    "opened_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "peer_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "peer_tasks_pair_a_id_pair_b_id_status_created_at_idx" ON "peer_tasks"("pair_a_id", "pair_b_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "peer_tasks_status_expires_at_idx" ON "peer_tasks"("status", "expires_at");

-- CreateIndex
CREATE INDEX "peer_tasks_agent_id_status_idx" ON "peer_tasks"("agent_id", "status");

-- CreateIndex
CREATE INDEX "peer_tasks_home_conversation_id_status_idx" ON "peer_tasks"("home_conversation_id", "status");

-- AddForeignKey
ALTER TABLE "peer_tasks" ADD CONSTRAINT "peer_tasks_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "peer_tasks" ADD CONSTRAINT "peer_tasks_peer_agent_id_fkey" FOREIGN KEY ("peer_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "peer_tasks" ADD CONSTRAINT "peer_tasks_home_conversation_id_fkey" FOREIGN KEY ("home_conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "peer_tasks" ADD CONSTRAINT "peer_tasks_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ONE OPEN PEER TASK PER PAIR (either direction), enforced by a partial
-- unique index on the sorted pair. Hand-appended: Prisma 6 cannot express a
-- partial index in PSL and its differ ignores partial indexes (`indpred IS
-- NULL`), so this survives `migrate dev` the same way the turns one-active
-- lock and the repo's CHECK constraints do.
--
-- UPGRADE LANDMINE: Prisma >= 7.4 introspects partial indexes and will emit a
-- DROP INDEX for one it cannot find in the schema. That upgrade must move this
-- into PSL (`@@unique([...], where: ...)`, partialIndexes preview) in the same
-- change, together with "turns_one_active_per_conversation".
CREATE UNIQUE INDEX "peer_tasks_one_open_per_pair"
  ON "peer_tasks" ("pair_a_id", "pair_b_id")
  WHERE "status" = 'open';
