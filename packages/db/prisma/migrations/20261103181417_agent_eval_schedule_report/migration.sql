-- AlterTable
ALTER TABLE "agent_eval_schedules" ADD COLUMN     "report_channel_label" TEXT,
ADD COLUMN     "report_channel_ref" TEXT,
ADD COLUMN     "report_to" TEXT,
ADD COLUMN     "report_when" TEXT NOT NULL DEFAULT 'always';
