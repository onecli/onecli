-- Workspace-tier skills are retired: a skill is either an agent's own or the
-- organization's (agent > organization).
--
-- EXPAND step of expand/contract (CLOUD-DEVELOPMENT.md): this migration runs
-- BEFORE the service rollout, while old api containers may still create
-- workspace skills. It moves the data and pins the tier dead at the database,
-- but keeps the now-always-NULL `workspace_id` column (and its FK/unique) so
-- old code can still read the table. A follow-up contract migration drops the
-- column once no deployed code references it.

-- ── 0. Hold off writers for the copy-then-delete below. The script runs as
-- one transaction, but each statement reads afresh: without this an old
-- container could create or edit a workspace skill between the copy and the
-- delete, and the delete would drop it uncopied. EXCLUSIVE blocks writes
-- only; reads (the composer, the dashboard) carry on. `skills` alone: the
-- app's edit path writes `skill_files` before `skills` and its create path
-- the reverse, so locking both would deadlock an in-flight write either way.
-- The one write this can still deadlock with is an edit of a WORKSPACE skill
-- caught between its two statements (the unlocked script deadlocks there
-- too). Postgres aborts one side: the edit fails and can be retried, or the
-- migration rolls back whole and the deploy fails cleanly to be re-run.
LOCK TABLE "skills" IN EXCLUSIVE MODE;

-- ── 1. Preserve behavior: copy each workspace skill onto every hosted agent
-- of its workspace that does not already hold a skill of that name. An
-- enabled own row already shadowed the workspace row, so skipping changes
-- nothing for that agent. A PAUSED own row did not (a paused row never
-- tombstones a broader tier), but the per-agent name unique leaves no room
-- for a copy, and the agent's own row wins: that agent stops receiving the
-- workspace version until someone resumes or renames its own. Disabled
-- workspace rows copy as disabled. Copies can take an agent past
-- MAX_SKILLS_PER_AGENT (a service-level cap: new creates refuse until it is
-- back under; what is materialized does not grow, since the agent already
-- carried these). An install that never used the workspace tier copies
-- nothing.
CREATE TEMP TABLE "_ws_skill_copy" AS
SELECT
  s."id"                  AS "old_id",
  gen_random_uuid()::text AS "new_id",
  a."id"                  AS "agent_id"
FROM "skills" s
JOIN "agents" a
  ON a."workspace_id" = s."workspace_id" AND a."kind" = 'hosted'
WHERE s."scope" = 'workspace'
  AND NOT EXISTS (
    SELECT 1 FROM "skills" own
    WHERE own."agent_id" = a."id" AND own."name" = s."name"
  );

INSERT INTO "skills" (
  "id", "scope", "agent_id", "name", "description", "content", "enabled",
  "created_by_user_id", "created_by_email", "created_at", "updated_at"
)
SELECT
  c."new_id", 'agent', c."agent_id", s."name", s."description", s."content",
  s."enabled", s."created_by_user_id", s."created_by_email", s."created_at",
  CURRENT_TIMESTAMP
FROM "_ws_skill_copy" c
JOIN "skills" s ON s."id" = c."old_id";

INSERT INTO "skill_files" ("id", "skill_id", "path", "content", "created_at", "updated_at")
SELECT gen_random_uuid()::text, c."new_id", f."path", f."content", f."created_at", CURRENT_TIMESTAMP
FROM "_ws_skill_copy" c
JOIN "skill_files" f ON f."skill_id" = c."old_id";

-- skill_files cascade with their skill.
DELETE FROM "skills" WHERE "scope" = 'workspace';
DROP TABLE "_ws_skill_copy";

-- ── 2. Two tiers, enforced: workspace_id can no longer be set, and the
-- workspace scope is refused outright. An old container's workspace-skill
-- create during the rollout window now fails loudly instead of landing.
ALTER TABLE "skills" DROP CONSTRAINT "skills_one_owner";
ALTER TABLE "skills" DROP CONSTRAINT "skills_scope_coherent";

ALTER TABLE "skills"
  ADD CONSTRAINT "skills_one_owner"
  CHECK (
    "workspace_id" IS NULL
    AND num_nonnulls("agent_id", "organization_id") = 1
  );

ALTER TABLE "skills"
  ADD CONSTRAINT "skills_scope_coherent"
  CHECK (
    "scope" IN ('agent', 'organization')
    AND (("scope" = 'agent') = ("agent_id" IS NOT NULL))
    AND (("scope" = 'organization') = ("organization_id" IS NOT NULL))
  );
