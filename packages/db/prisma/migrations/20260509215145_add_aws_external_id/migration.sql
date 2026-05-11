-- AlterTable
ALTER TABLE "agent_app_connections" ADD COLUMN     "session_policy" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "aws_external_id" TEXT;
