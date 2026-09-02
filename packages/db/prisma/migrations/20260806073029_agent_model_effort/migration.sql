-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "effort" TEXT,
ADD COLUMN     "model_provider" TEXT;

-- Clear any model written before this change, because Postgres validates a new
-- CHECK against existing rows and every such row would fail it — aborting the
-- migration, which runs at container startup, and taking the API server down
-- with it. Not a backfill in the usual sense: a pre-change `model` carries no
-- provider stamp and cannot be attributed to one, so there is nothing to
-- migrate it TO. Clearing lands those agents on their granted key's default,
-- which is the state §3.10 calls normal — and the same thing
-- `dropStaleModelOverride` does whenever an override loses its provider.
UPDATE "agents" SET "model" = NULL WHERE "model" IS NOT NULL;

-- Hand-appended (Prisma has no CHECK support): the model override and the
-- provider stamp that qualifies it are one fact in two columns, and two of the
-- four states they can spell are meaningless.
--
--   model/effort set, provider set    → an override, qualified. Legal.
--   model/effort null, provider null  → no override at all. Legal, and normal.
--   model/effort set, provider NULL   → an override belonging to nobody: the
--                                       key-swap rule cannot tell whether it
--                                       still applies, so it would be honoured
--                                       forever, against every provider.
--   model/effort null, provider set   → a stamp qualifying nothing.
--
-- Either override alone is deliberately permitted — "keep the default model
-- but think harder" is a real thing to want.
--
-- Note that `resolveAgentModel` ALSO ignores an override whose provider does
-- not match, so a bug that somehow wrote an incoherent row degrades to the
-- default rather than misbehaving. This constraint is why that can only ever
-- be belt-and-braces.
ALTER TABLE "agents" ADD CONSTRAINT "agents_model_override_coherent"
  CHECK (("model" IS NOT NULL OR "effort" IS NOT NULL) = ("model_provider" IS NOT NULL));

-- AlterTable
ALTER TABLE "turns" ADD COLUMN     "error_code" TEXT;
