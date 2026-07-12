-- Step 13b pre-flip re-seed (belt-and-suspenders): before project USAGE flips to
-- bindings-only, re-snapshot the creator seed one more time so no project is left
-- with zero human bindings. Identical to the 13a reseed
-- (20260710074529_reseed_project_access_creators), re-run here to also bind any
-- project created in the window between that migration's deploy and this one.
-- Idempotent via ON CONFLICT, so re-running is safe. created_by_user_id stays
-- NULL on seeded rows (= system write); updated_at is supplied explicitly
-- (Prisma's @updatedAt is client-side only).
INSERT INTO "project_access" ("id", "project_id", "user_id", "created_at", "updated_at")
SELECT gen_random_uuid(), p."id", p."created_by_user_id", now(), now()
FROM "projects" p
WHERE p."created_by_user_id" IS NOT NULL
ON CONFLICT ("project_id", "user_id") DO NOTHING;

-- Pinned verification (MUST return 0 before the flip serves): every project with
-- a recorded creator now carries at least one human (user) binding. This is the
-- invariant 13b's bindings-only usage gate depends on — run it against the target
-- DB after this migration deploys and before promoting the app that flips usage.
--
--   SELECT COUNT(*) FROM "projects" p
--   WHERE p."created_by_user_id" IS NOT NULL
--     AND NOT EXISTS (
--       SELECT 1 FROM "project_access" pa
--       WHERE pa."project_id" = p."id" AND pa."user_id" IS NOT NULL
--     );
