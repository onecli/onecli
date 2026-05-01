-- AlterTable
ALTER TABLE "users" ADD COLUMN "onboarding_completed_at" TIMESTAMP(3);

-- Backfill: copy onboarding_completed_at from each user's org to the user
UPDATE "users" u
SET "onboarding_completed_at" = o."onboarding_completed_at"
FROM "organization_members" om
JOIN "organizations" o ON o."id" = om."organization_id"
WHERE om."user_id" = u."id"
  AND o."onboarding_completed_at" IS NOT NULL;

-- AlterTable
ALTER TABLE "organizations" DROP COLUMN "onboarding_completed_at";
