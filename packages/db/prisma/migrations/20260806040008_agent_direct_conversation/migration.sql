-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "direct" BOOLEAN NOT NULL DEFAULT false;

-- Hand-appended (Prisma's @@unique has no WHERE clause): at most one DIRECT
-- conversation per agent — the §3.18 invariant. The agent is the thread: the
-- web surface and the future Slack DM (step 6) are two doors onto this one
-- row, which is why the index is NOT keyed by "source". Non-direct
-- conversations (Slack channels, crons, watches) stay unlimited.
--
-- Deliberately NOT declared as @@unique in schema.prisma: Prisma 6's differ
-- ignores the WHERE clause and would fight it (endless recreate). It is
-- invisible to drift here because the Postgres describer filters partial
-- indexes (`indpred IS NULL`) — the same reason `turns_one_active_per_conversation`
-- and this repo's hand-appended CHECK constraints survive `migrate dev`.
--
-- UPGRADE LANDMINE: Prisma >= 7.4 introspects partial indexes and will emit a
-- DROP INDEX for one it cannot find in the schema. That upgrade must move this
-- into PSL (`@@unique([...], where: ...)`, partialIndexes preview) in the same
-- change. See plans/hosted-agents-v2.md §3.18.
CREATE UNIQUE INDEX "conversations_one_direct_per_agent"
  ON "conversations" ("agent_id")
  WHERE "direct";
