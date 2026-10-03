-- Deleting an agent cascaded its policy_rule_identities rows off its grant
-- rules and left the rules behind with NO identity. In the block/allow engine
-- an empty identity means "every agent", so a deleted agent's grant stack
-- ("allowed" / "needs approval" / "everything else: block") silently applied
-- to every other agent in the workspace — its "everything else" block overrode
-- other agents' own grants (observed live).
--
-- A grant rule (source = 'grant') is by definition ONE agent's rule, so a
-- grant with no identity is always such an orphan. Delete them, draft and
-- published alike; targets/conditions cascade. Hand-written rules
-- (source <> 'grant') and the terminal Default Rule are never touched, and an
-- identity-less HAND-WRITTEN rule stays exactly as authored ("applies to
-- everyone" is legitimate there).
--
-- Idempotent. Going forward, agent delete drops every rule naming only that
-- agent in the same transaction (agent-service deleteAgent →
-- policy-service dropAgentFromPolicyInTx).
DELETE FROM "policy_rules_v2" r
WHERE r."source" = 'grant'
  AND NOT EXISTS (
    SELECT 1 FROM "policy_rule_identities" i WHERE i."rule_id" = r."id"
  );
