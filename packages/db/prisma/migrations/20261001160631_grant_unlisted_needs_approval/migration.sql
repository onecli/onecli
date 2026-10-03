-- A customized connection grant ends in an "everything else" row covering the
-- requests its app catalog does not describe (grants-compile.ts). It was a
-- BLOCK, which dead-ended ordinary flows whose prerequisite calls no catalog
-- lists; it now NEEDS APPROVAL. This converts the row in EXISTING stacks so
-- they behave like freshly compiled ones without waiting for a re-save.
--
-- The row is found by shape, not name (names embed user labels): a grant BLOCK
-- whose single connection target names NO tools (the whole app). Every other
-- grant block carries the explicit blocked-complement tool list and is left
-- alone, so tools set to Never stay blocked. AWS catalogs opt out
-- (`unlisted: "block"`, their credential spans every `*.amazonaws.com`
-- service), so their rows stay blocks.
--
-- The converted row takes the session-policy conditions of its stack's first
-- allow row (same agent, connection, status and generation), as the compiler
-- does: the gateway assembles the session policy last-match-wins over matching
-- allow rows, so a condition-less approval row would clear a resources
-- restriction. A stack with no conditioned allow row carries none.
--
-- Draft and every published generation alike: the gateway reads the max
-- published generation, and the older ones are rollback copies that must not
-- resurrect the block. Idempotent: a converted row is no longer a block.
UPDATE "policy_rules_v2" r
SET "action" = 'allow',
    "require_approval" = true,
    "conditions" = (
      SELECT s."conditions"
      FROM "policy_rules_v2" s
      JOIN "policy_rule_targets" st ON st."rule_id" = s."id"
      JOIN "policy_rule_identities" si ON si."rule_id" = s."id"
      WHERE s."source" = 'grant'
        AND s."action" = 'allow'
        AND s."conditions" IS NOT NULL
        AND s."conditions" <> 'null'::jsonb
        AND s."status" = r."status"
        AND s."generation" = r."generation"
        AND s."scope" = r."scope"
        AND s."workspace_id" IS NOT DISTINCT FROM r."workspace_id"
        AND s."organization_id" IS NOT DISTINCT FROM r."organization_id"
        AND st."kind" = 'connection'
        AND st."app_connection_id" = (
          SELECT t."app_connection_id" FROM "policy_rule_targets" t
          WHERE t."rule_id" = r."id" LIMIT 1
        )
        AND si."agent_id" = (
          SELECT i."agent_id" FROM "policy_rule_identities" i
          WHERE i."rule_id" = r."id" LIMIT 1
        )
      ORDER BY s."priority" ASC
      LIMIT 1
    )
WHERE r."source" = 'grant'
  AND r."action" = 'block'
  AND EXISTS (
    SELECT 1
    FROM "policy_rule_targets" t
    JOIN "app_connections" c ON c."id" = t."app_connection_id"
    WHERE t."rule_id" = r."id"
      AND t."kind" = 'connection'
      AND cardinality(t."app_tools") = 0
      AND c."provider" NOT IN ('aws', 'aws-role')
  );
