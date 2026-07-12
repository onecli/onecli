-- Step 13a re-seed: give every project an explicit ProjectAccess binding for
-- its creator. This re-runs the idempotent creator seed from
-- 20260709074105_add_groups_agent_groups_access_bindings as belt-and-suspenders
-- AND, crucially, binds every project created in the window between that
-- migration's deploy and 13a's transactional creator-binding landing (project
-- creation didn't seed a binding until 13a). Idempotent via ON CONFLICT, so
-- re-running is safe. created_by_user_id stays NULL on seeded rows (= system
-- write); updated_at is supplied explicitly (Prisma's @updatedAt is client-side).
INSERT INTO "project_access" ("id", "project_id", "user_id", "created_at", "updated_at")
SELECT gen_random_uuid(), p."id", p."created_by_user_id", now(), now()
FROM "projects" p
WHERE p."created_by_user_id" IS NOT NULL
ON CONFLICT ("project_id", "user_id") DO NOTHING;

-- Pinned verification (must return 0): every project with a recorded creator now
-- carries at least one human (user) binding. This is the invariant 13b's flip to
-- bindings-only depends on.
--
--   SELECT COUNT(*) FROM "projects" p
--   WHERE p."created_by_user_id" IS NOT NULL
--     AND NOT EXISTS (
--       SELECT 1 FROM "project_access" pa
--       WHERE pa."project_id" = p."id" AND pa."user_id" IS NOT NULL
--     );
