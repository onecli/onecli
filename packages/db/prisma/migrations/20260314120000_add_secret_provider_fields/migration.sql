-- Add pluggable secret provider support.
-- Existing rows default to local_db with existing encryptedValue preserved.
ALTER TABLE "Secret"
  ADD COLUMN "providerType" TEXT NOT NULL DEFAULT 'local_db',
  ADD COLUMN "providerRef" TEXT,
  ALTER COLUMN "encryptedValue" DROP NOT NULL;

CREATE INDEX "Secret_providerType_idx" ON "Secret"("providerType");
