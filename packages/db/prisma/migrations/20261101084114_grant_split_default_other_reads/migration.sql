-- Gives existing connection grants on audited catalogs the "Other reads:
-- Always allow" default that new attaches have had since #1412
-- (grants-compile.ts `defaultOtherReads`). Before it, every customized stack
-- ended in ONE "everything else" needs-approval row covering reads and writes
-- alike, so a GET outside the app's tool list (Attio /v2/meetings, Outlook
-- calendarView) waited for a human. Most of those rows were written by
-- 20261011191656_grant_default_unlisted_needs_approval, not chosen by anyone.
--
-- Converted: a grant's single terminal row (allow + needs approval, naming one
-- agent and one connection, no tools and no method), on a catalog audited
-- with `unlistedReads: "allow"` (snapshot below), whose rule FIRST appeared
-- before #1412 merged. AWS, Twilio and every catalog with a
-- credential-returning or state-changing GET are absent from the snapshot.
-- GitHub's one such GET family, secret scanning alerts, is held for approval
-- by the gateway whatever a grant allows. "First appeared" is the earliest
-- created_at across the rule's logical id: publishing copies a rule into a new
-- generation with a fresh created_at, so a draft's age is the rule's age. A
-- rule first written after #1412 had the split default on offer, so one
-- needs-approval terminal there is kept as the user's choice. The cutoff is
-- the merge, not each install's upgrade: a stack an install wrote between the
-- two keeps its terminal, which is the stricter choice and one click to
-- change. Older stacks use an em dash before "everything else"; both forms
-- match, and the new rows take today's colon.
--
-- Into exactly what the compiler writes for otherReads=allow,
-- otherWrites=ask: the stricter row first, narrowed by method,
--   "<base>: all other writes"  allow + approval, method !GET,HEAD  (the row)
--   "<base>: all other reads"   allow, whole app                    (new)
-- with the terminal's own conditions and agent. Priorities in each affected
-- policy set are doubled so the new row slots right after its source. Draft
-- and every published generation alike (older generations are rollback
-- copies). Idempotent: a converted row carries a method, so it no longer
-- matches.

-- Hold off policy writers until this commits. Each statement reads afresh, so
-- a grant save landing mid-migration could replace a stack after it was
-- selected, and the new "all other reads" row would then sit alone, unnarrowed
-- and above whatever the save wrote. EXCLUSIVE blocks writes only: the
-- gateway's reads carry on. A writer that touched one of these tables before
-- the lock and needs another after it can deadlock with this; Postgres aborts
-- one side and either the write or the migration (and so the deploy) re-runs.
LOCK TABLE "policy_rules_v2", "policy_rule_identities", "policy_rule_targets"
  IN EXCLUSIVE MODE;

WITH audited(provider) AS (
  VALUES
    ('affinity'), ('apollo-io'), ('attio'), ('circleback'), ('clay'),
    ('confluence'), ('docker'), ('dripify'), ('dropbox'), ('fathom'),
    ('fireflies'), ('github'), ('github-app'), ('gmail'), ('google-admin'),
    ('google-analytics'), ('google-calendar'), ('google-chat'),
    ('google-classroom'), ('google-contacts'), ('google-docs'),
    ('google-drive'), ('google-forms'), ('google-keep'), ('google-meet'),
    ('google-photos'), ('google-search-console'), ('google-sheets'),
    ('google-slides'), ('google-tasks'), ('granola'), ('hubspot'), ('jira'),
    ('linear'), ('linkedin'), ('microsoft-onenote'), ('monday'),
    ('mongodb-atlas'), ('navan'), ('notion'), ('outlook-calendar'),
    ('outlook-mail'), ('pylon'), ('snowflake'), ('tavily'), ('timeless'),
    ('todoist'), ('trello'), ('webflow'), ('x'), ('zoom')
),
first_seen AS (
  SELECT "logical_id", min("created_at") AS "at"
  FROM "policy_rules_v2"
  WHERE "source" = 'grant'
  GROUP BY "logical_id"
),
terminal AS MATERIALIZED (
  SELECT
    r."id",
    r."scope",
    r."workspace_id",
    r."organization_id",
    r."status",
    r."generation",
    r."priority",
    regexp_replace(r."name", '(: | — )everything else$', '') AS "base",
    r."conditions",
    r."logical_id",
    r."created_by_user_id",
    i."agent_id",
    t."id" AS "target_id",
    t."app_connection_id",
    gen_random_uuid()::text AS "new_id"
  FROM "policy_rules_v2" r
  JOIN first_seen f ON f."logical_id" = r."logical_id"
  JOIN "policy_rule_identities" i ON i."rule_id" = r."id"
  JOIN "policy_rule_targets" t ON t."rule_id" = r."id"
  JOIN "app_connections" ac ON ac."id" = t."app_connection_id"
  JOIN audited a ON a."provider" = ac."provider"
  WHERE r."source" = 'grant'
    AND r."enabled" = true
    AND r."action" = 'allow'
    AND r."require_approval" = true
    AND r."is_default" = false
    AND r."name" ~ '(: | — )everything else$'
    AND i."agent_id" IS NOT NULL
    AND t."kind" = 'connection'
    AND cardinality(t."app_tools") = 0
    AND COALESCE(t."method", '') = ''
    -- One agent and one connection, the only shape the compiler writes. A row
    -- the policy editor gave more is no compiled grant any more: it stays.
    AND (SELECT count(*) FROM "policy_rule_identities" ci WHERE ci."rule_id" = r."id") = 1
    AND (SELECT count(*) FROM "policy_rule_targets" ct WHERE ct."rule_id" = r."id") = 1
    -- #1412 merged 2026-10-24 17:53:19 UTC.
    AND f."at" < TIMESTAMP '2026-10-24 17:53:19'
    -- The only whole-app row of its stack: never a half-split one.
    AND NOT EXISTS (
      SELECT 1
      FROM "policy_rules_v2" s
      JOIN "policy_rule_identities" si ON si."rule_id" = s."id"
      JOIN "policy_rule_targets" st ON st."rule_id" = s."id"
      WHERE s."id" <> r."id"
        AND s."source" = 'grant'
        AND s."status" = r."status"
        AND s."generation" = r."generation"
        AND s."scope" = r."scope"
        AND s."workspace_id" IS NOT DISTINCT FROM r."workspace_id"
        AND s."organization_id" IS NOT DISTINCT FROM r."organization_id"
        AND si."agent_id" = i."agent_id"
        AND st."app_connection_id" = t."app_connection_id"
        AND cardinality(st."app_tools") = 0
    )
),
affected AS (
  SELECT DISTINCT "scope", "workspace_id", "organization_id", "status", "generation"
  FROM terminal
),
renumbered AS (
  UPDATE "policy_rules_v2" p
  SET "priority" = p."priority" * 2,
      "name" = CASE
        WHEN p."id" IN (SELECT "id" FROM terminal)
          THEN (SELECT tm."base" FROM terminal tm WHERE tm."id" = p."id") || ': all other writes'
        ELSE p."name"
      END,
      "updated_at" = CASE
        WHEN p."id" IN (SELECT "id" FROM terminal) THEN CURRENT_TIMESTAMP
        ELSE p."updated_at"
      END
  FROM affected a
  WHERE p."scope" = a."scope"
    AND p."workspace_id" IS NOT DISTINCT FROM a."workspace_id"
    AND p."organization_id" IS NOT DISTINCT FROM a."organization_id"
    AND p."status" = a."status"
    AND p."generation" = a."generation"
  RETURNING p."id"
),
narrowed AS (
  UPDATE "policy_rule_targets" t
  SET "method" = '!GET,HEAD'
  FROM terminal tm
  WHERE t."id" = tm."target_id"
  RETURNING t."id"
),
reads AS (
  INSERT INTO "policy_rules_v2" (
    "id", "scope", "organization_id", "workspace_id", "status", "generation",
    "priority", "enabled", "is_default", "logical_id", "source", "name",
    "action", "require_approval", "conditions", "created_by_user_id",
    "created_at", "updated_at"
  )
  SELECT
    tm."new_id", tm."scope", tm."organization_id", tm."workspace_id",
    tm."status", tm."generation", tm."priority" * 2 + 1, true, false,
    md5(tm."logical_id" || ':all-other-reads')::uuid::text, 'grant',
    tm."base" || ': all other reads', 'allow', false, tm."conditions",
    tm."created_by_user_id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM terminal tm
  RETURNING "id"
),
reads_identity AS (
  INSERT INTO "policy_rule_identities" ("id", "rule_id", "agent_id")
  SELECT gen_random_uuid()::text, tm."new_id", tm."agent_id"
  FROM terminal tm
  RETURNING "id"
)
INSERT INTO "policy_rule_targets" ("id", "rule_id", "kind", "app_connection_id", "app_tools")
SELECT gen_random_uuid()::text, tm."new_id", 'connection', tm."app_connection_id", ARRAY[]::text[]
FROM terminal tm;
