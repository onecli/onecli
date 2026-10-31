-- AlterTable
ALTER TABLE "agent_read_grants" ADD COLUMN     "read_mode" TEXT NOT NULL DEFAULT 'allow',
ADD COLUMN     "write_mode" TEXT NOT NULL DEFAULT 'never';
