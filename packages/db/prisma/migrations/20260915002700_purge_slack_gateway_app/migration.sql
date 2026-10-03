-- Slack is no longer a gateway app (plans/channel-aware-agents.md). An
-- agent's Slack access IS its own channel app (agent_channels);
-- the gateway never injects Slack credentials again. Every row the old
-- "Connect Slack" integration left behind is deleted here so a workspace
-- that connected Slack in the past sees nothing and no code path has to
-- tolerate a provider the registry no longer knows. Idempotent: every
-- statement is a no-op on a database that never had Slack rows.
--
-- Channel tables (channel_integrations, agent_channels, ...) also
-- carry provider = 'slack' and are NOT touched: they are the replacement.

-- 1. Policy rules whose ONLY targets are Slack — the app target
--    (app_provider = 'slack') or a connection target on a Slack connection.
--    A custom rule orphaned to zero targets is fail-closed in the engine and
--    unrepresentable in the authoring API ("A rule must name at least one
--    target"), so it would be an uneditable dead row. Delete the whole rule
--    (its identities and targets cascade). The terminal Default Rule is
--    target-less by construction and never matches the EXISTS below.
DELETE FROM "policy_rules_v2" r
WHERE EXISTS (
  SELECT 1 FROM "policy_rule_targets" t
  WHERE t."rule_id" = r."id"
)
AND NOT EXISTS (
  SELECT 1 FROM "policy_rule_targets" t
  LEFT JOIN "app_connections" c ON c."id" = t."app_connection_id"
  WHERE t."rule_id" = r."id"
    AND COALESCE(t."app_provider", '') <> 'slack'
    AND COALESCE(c."provider", '') <> 'slack'
);

-- 2. Mixed rules keep their other targets; only the Slack app targets go.
--    (Connection targets on Slack connections cascade with step 3.)
DELETE FROM "policy_rule_targets" WHERE "app_provider" = 'slack';

-- 3. The connections themselves (encrypted OAuth tokens included) and their
--    per-workspace / per-org OAuth client configs. policy_rule_targets rows
--    that named these connections cascade.
DELETE FROM "app_connections" WHERE "provider" = 'slack';
DELETE FROM "app_configs" WHERE "provider" = 'slack';

-- 4. Availability rules granted 'slack' among their apps: drop the id. A
--    rule left with no apps grants nothing (the service already treats it
--    as a no-op and never persists one), so delete those outright.
UPDATE "app_availability_rules"
SET "providers" = array_remove("providers", 'slack')
WHERE 'slack' = ANY("providers");
DELETE FROM "app_availability_rules" WHERE cardinality("providers") = 0;
