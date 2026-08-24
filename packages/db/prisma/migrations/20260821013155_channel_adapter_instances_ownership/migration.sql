-- AlterTable
ALTER TABLE "agent_channels" ADD COLUMN     "owner_adapter_id" TEXT,
ADD COLUMN     "owner_lease_expires_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "channel_adapters" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'anchor';

-- AlterTable
ALTER TABLE "channel_integrations" ADD COLUMN     "rotate_claimed_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "agent_channels_owner_adapter_id_idx" ON "agent_channels"("owner_adapter_id");

-- AddForeignKey
ALTER TABLE "agent_channels" ADD CONSTRAINT "agent_channels_owner_adapter_id_fkey" FOREIGN KEY ("owner_adapter_id") REFERENCES "channel_adapters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
