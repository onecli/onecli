-- CreateTable
CREATE TABLE "channel_cleanups" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "source_presence_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "credentials" TEXT,
    "delete_remote" BOOLEAN NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'uninstall',
    "state" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claim_token" TEXT,
    "claim_expires_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_cleanups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_cleanups_state_next_attempt_at_idx" ON "channel_cleanups"("state", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "channel_cleanups_provider_external_id_key" ON "channel_cleanups"("provider", "external_id");
