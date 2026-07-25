-- Add the generation-stable logical id. Backfill any existing rows (there are
-- none in prod — the step-5 backfill has not run — but stay safe on non-empty
-- tables) with fresh uuids, then enforce NOT NULL. A DB-level default (not just
-- the Prisma client-side one) so an old still-serving instance's insert during a
-- rolling deploy can't hit a not-null violation. A published snapshot copies its
-- source draft's value.
ALTER TABLE "policy_rules_v2" ADD COLUMN "logical_id" TEXT;
UPDATE "policy_rules_v2" SET "logical_id" = gen_random_uuid()::text WHERE "logical_id" IS NULL;
ALTER TABLE "policy_rules_v2" ALTER COLUMN "logical_id" SET NOT NULL;
ALTER TABLE "policy_rules_v2" ALTER COLUMN "logical_id" SET DEFAULT gen_random_uuid();
