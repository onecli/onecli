/*
  Warnings:

  - A unique constraint covering the columns `[channel_connection_id]` on the table `sandboxes` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[channel_token_hash]` on the table `sandboxes` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN     "channel_connection_id" TEXT,
ADD COLUMN     "channel_replica_id" TEXT,
ADD COLUMN     "channel_since" TIMESTAMP(3),
ADD COLUMN     "channel_token_hash" TEXT,
ADD COLUMN     "owner_replica_id" TEXT;

-- CreateTable
CREATE TABLE "runner_replicas" (
    "id" TEXT NOT NULL,
    "runner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "port_api_url" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runner_replicas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "runner_replicas_runner_id_last_seen_at_idx" ON "runner_replicas"("runner_id", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "sandboxes_channel_connection_id_key" ON "sandboxes"("channel_connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "sandboxes_channel_token_hash_key" ON "sandboxes"("channel_token_hash");

-- CreateIndex
CREATE INDEX "sandboxes_channel_replica_id_idx" ON "sandboxes"("channel_replica_id");

-- CreateIndex
CREATE INDEX "sandboxes_owner_replica_id_idx" ON "sandboxes"("owner_replica_id");

-- AddForeignKey
ALTER TABLE "runner_replicas" ADD CONSTRAINT "runner_replicas_runner_id_fkey" FOREIGN KEY ("runner_id") REFERENCES "runners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_channel_replica_id_fkey" FOREIGN KEY ("channel_replica_id") REFERENCES "runner_replicas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_owner_replica_id_fkey" FOREIGN KEY ("owner_replica_id") REFERENCES "runner_replicas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
