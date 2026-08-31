-- AlterTable
ALTER TABLE "agent_channels" ADD COLUMN     "app_mode" TEXT NOT NULL DEFAULT 'regular';

-- AlterTable
ALTER TABLE "channel_integrations" ADD COLUMN     "app_mode" TEXT NOT NULL DEFAULT 'agent';

-- AlterTable
ALTER TABLE "channel_turn_receipts" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'reaction',
ALTER COLUMN "reaction" DROP NOT NULL;
