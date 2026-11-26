-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "context_fit_checked_at" TIMESTAMP(3),
ADD COLUMN     "context_tokens" INTEGER,
ADD COLUMN     "context_tokens_changed_at" TIMESTAMP(3);

-- Hand-appended (Prisma has no CHECK syntax): the size is one rung of the
-- context-fit ladder (`context-fit-rule.ts`) or null for the default, and a
-- size always carries the time it was chosen (the job's cooldown clock).
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_context_tokens_ladder"
  CHECK ("context_tokens" IS NULL OR "context_tokens" IN (100000, 200000, 1000000));
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_context_tokens_dated"
  CHECK ("context_tokens" IS NULL OR "context_tokens_changed_at" IS NOT NULL);
