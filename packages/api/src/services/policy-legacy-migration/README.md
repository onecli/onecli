# Legacy policy migration (TEMPORARY — delete this whole directory)

Everything in this directory exists to convert the **retired** policy model into
`policy_rules_v2`, for self-hosted instances that upgrade across the step-10
release. It is dead weight the moment the last supported upgrade path has passed
through it.

## Why it has to exist

Step 10 (2026-07) made `policy_rules_v2` the only model. The gateway no longer
reads `policy_rules`, `agent_secrets` or `agent_app_connections` at all, and it
decides **Allow** on an empty rule set. So an instance that upgrades from a
pre-cutover release straight to a post-step-10 one would keep running while its
blocks, rate limits and approvals silently stopped applying.

This converts such an instance on boot instead, so the upgrade is safe from any
starting version.

## Scope: OSS only

`apps/web/src/lib/policy-migrate.ts` (the OSS boot seam) calls
`runLegacyPolicyMigration`. Every EE edition aliases that file away to
`apps/web/src/ee/policy-migrate.ts`, which runs only the read-only
`policy-migration-guard` — cloud was converted in 2026-07, and an onprem
instance in this state gets the guard's loud error rather than a silent
conversion. Nothing here is reachable from an EE build.

## Deleting it (with the tables, ~2027)

The removal is one commit, and `schema.prisma`'s `///` deprecation blocks carry
the same checklist:

1. Delete this directory.
2. Delete `services/policy-migration-guard.ts` and its two call sites
   (`apps/web/src/{lib,ee}/policy-migrate.ts` — the whole seam goes).
3. Delete the FK cleanup that only exists because the tables do:
   `ee/services/{project,organization}-service.ts`, and the `agentSecret`
   de-referencing in `apps/web/src/ee/account/actions.ts`.
4. Drop `PolicyRule`, `AgentSecret`, `AgentAppConnection` and
   `Organization.policyMode` from the schema. **Not** `Agent.secretMode` — that
   is live (the all-vs-rules injection switch); it retires with the
   eliminate-all-mode follow-up.

Nothing outside this list reads the old tables — that property is what makes the
drop a mechanical change, and it is worth re-proving with a grep before doing it.

## What is deliberately NOT here

The step-5..9 transition machinery — the backfill verifier, the coherence
bridge, rule compaction, the translation oracle, the adoption re-tag pass — was
deleted in step 10 and is not needed. Those existed to keep two models coherent
while BOTH were live. This is a one-shot conversion of a frozen model: read,
translate, publish once, verify, done. The translator already emits the final
`source="custom"` shape for app-permission rows, so no adoption pass is required.
