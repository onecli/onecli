/*
  Warnings:

  - A unique constraint covering the columns `[agent_id,source,external_ref]` on the table `conversations` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "conversations_agent_id_source_external_ref_idx";

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'user';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "user_id" TEXT;

-- AlterTable
ALTER TABLE "turns" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'web',
ADD COLUMN     "user_id" TEXT;

-- CreateTable
CREATE TABLE "channel_integrations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT,
    "credentials" TEXT,
    "credentials_rotated_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_channels" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "identity_ref" TEXT,
    "transport" TEXT NOT NULL,
    "credentials" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_setup',
    "created_by_user_id" TEXT,
    "api_key_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_user_links" (
    "id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "linked_via" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_user_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_thread_links" (
    "id" TEXT NOT NULL,
    "agent_channel_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "external_thread_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "external_user_id" TEXT,
    "mirror_cursor" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_thread_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_ingested_events" (
    "id" TEXT NOT NULL,
    "agent_channel_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_ingested_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_approval_prompts" (
    "id" TEXT NOT NULL,
    "approval_id" TEXT NOT NULL,
    "agent_channel_id" TEXT NOT NULL,
    "external_thread_id" TEXT NOT NULL,
    "external_message_ref" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_approval_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_adapters" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_adapters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_integrations_provider_external_id_idx" ON "channel_integrations"("provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_integrations_organization_id_provider_key" ON "channel_integrations"("organization_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "agent_channels_provider_external_id_key" ON "agent_channels"("provider", "external_id");

-- CreateIndex
CREATE INDEX "agent_channels_integration_id_idx" ON "agent_channels"("integration_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_channels_agent_id_provider_key" ON "agent_channels"("agent_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "channel_user_links_integration_id_external_user_id_key" ON "channel_user_links"("integration_id", "external_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_user_links_integration_id_user_id_key" ON "channel_user_links"("integration_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_thread_links_conversation_id_key" ON "channel_thread_links"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_thread_links_agent_channel_id_external_thread_id_key" ON "channel_thread_links"("agent_channel_id", "external_thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_ingested_events_agent_channel_id_event_id_key" ON "channel_ingested_events"("agent_channel_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_approval_prompts_approval_id_key" ON "channel_approval_prompts"("approval_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_adapters_token_key" ON "channel_adapters"("token");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_agent_id_source_external_ref_key" ON "conversations"("agent_id", "source", "external_ref");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turns" ADD CONSTRAINT "turns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_integrations" ADD CONSTRAINT "channel_integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_integrations" ADD CONSTRAINT "channel_integrations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_channels" ADD CONSTRAINT "agent_channels_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_channels" ADD CONSTRAINT "agent_channels_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "channel_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_channels" ADD CONSTRAINT "agent_channels_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_channels" ADD CONSTRAINT "agent_channels_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_user_links" ADD CONSTRAINT "channel_user_links_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "channel_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_user_links" ADD CONSTRAINT "channel_user_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_thread_links" ADD CONSTRAINT "channel_thread_links_agent_channel_id_fkey" FOREIGN KEY ("agent_channel_id") REFERENCES "agent_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_thread_links" ADD CONSTRAINT "channel_thread_links_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_ingested_events" ADD CONSTRAINT "channel_ingested_events_agent_channel_id_fkey" FOREIGN KEY ("agent_channel_id") REFERENCES "agent_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_approval_prompts" ADD CONSTRAINT "channel_approval_prompts_agent_channel_id_fkey" FOREIGN KEY ("agent_channel_id") REFERENCES "agent_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Hand-appended (Prisma cannot express these) ──────────────────────────────
-- Step 6's per-user pivot (plans/hosted-agents-v2.md §3.18 amendment): the
-- direct-thread invariant moves from one-per-agent to one-per-(agent, user).
--
-- v2 has never been deployed (recorded 2026-08-06: not prod, not dev), so the
-- only direct rows in existence live in local dev databases, and they cannot
-- be assigned an owner retroactively. They are deleted rather than orphaned —
-- loud and deliberate, dev data only.
DELETE FROM "conversations" WHERE "direct";

-- The one-per-agent partial unique index from 20260806040008, superseded.
DROP INDEX "conversations_one_direct_per_agent";

-- The per-user invariant: at most one direct thread per (agent, user).
-- Partial, so group/source conversations (direct = false) are never counted.
-- Deliberately a hand-written partial index, NOT @@unique in the schema —
-- Prisma 6's differ ignores the WHERE clause and would fight it (same
-- reasoning as turns_one_active_per_conversation).
CREATE UNIQUE INDEX "conversations_one_direct_per_agent_user"
  ON "conversations" ("agent_id", "user_id")
  WHERE "direct";

-- A direct thread always knows its owner. The partial index above cannot say
-- this on its own (a NULL user_id slips past NULLS DISTINCT uniqueness); the
-- CHECK closes it. Runs after the DELETE above, which cleared the only rows
-- that could violate it.
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_direct_requires_user"
  CHECK (NOT "direct" OR "user_id" IS NOT NULL);
