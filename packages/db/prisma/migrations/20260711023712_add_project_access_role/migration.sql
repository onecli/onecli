-- Step 13c: management authority moves onto a ProjectAccess role. New user/group
-- bindings default to "member" (a plain use grant); "owner" carries management
-- (rename/share/delete). Only user bindings carry a management role in v1.

-- AlterTable
ALTER TABLE "project_access" ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'member';

-- Backfill: promote each project creator's OWN binding to "owner" so the
-- canManageProject flip is behavior-preserving — creator-or-admin ≡ owner-or-admin
-- the instant the check changes. Shared-in member bindings and group bindings keep
-- the "member" default. Idempotent (re-running only re-asserts the same rows).
UPDATE "project_access" pa
SET "role" = 'owner'
FROM "projects" p
WHERE pa."project_id" = p."id"
  AND pa."user_id" = p."created_by_user_id"
  AND pa."user_id" IS NOT NULL;

-- Pinned verification (should return 0): every project with a recorded creator now
-- has its creator binding at role "owner" (the invariant the management flip relies
-- on — every project stays manageable by its owner, not just by org admins).
--
--   SELECT COUNT(*) FROM "projects" p
--   WHERE p."created_by_user_id" IS NOT NULL
--     AND EXISTS (
--       SELECT 1 FROM "project_access" pa
--       WHERE pa."project_id" = p."id" AND pa."user_id" = p."created_by_user_id"
--     )
--     AND NOT EXISTS (
--       SELECT 1 FROM "project_access" pa
--       WHERE pa."project_id" = p."id" AND pa."user_id" = p."created_by_user_id"
--         AND pa."role" = 'owner'
--     );
