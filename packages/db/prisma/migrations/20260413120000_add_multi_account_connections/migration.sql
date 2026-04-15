-- AlterTable: add label column
ALTER TABLE "app_connections" ADD COLUMN "label" TEXT;

-- Backfill labels from metadata
UPDATE "app_connections" SET "label" = COALESCE(metadata->>'email', metadata->>'username', metadata->>'name') WHERE metadata IS NOT NULL;

-- DropIndex: remove one-per-provider unique constraint (allow multiple connections per provider)
DROP INDEX "app_connections_account_id_provider_key";

-- CreateIndex: non-unique index for queries by account + provider
CREATE INDEX "app_connections_account_id_provider_idx" ON "app_connections"("account_id", "provider");
