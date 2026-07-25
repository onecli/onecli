import { runLegacyPolicyMigration } from "@onecli/api/services/policy-legacy-migration";
import { guardUnmigratedPolicy } from "@onecli/api/services/policy-migration-guard";

/**
 * The OSS boot policy seam. `policy_rules_v2` is the only model the gateway
 * reads since step 10, and it decides Allow on an empty rule set — so an
 * instance upgrading from a pre-cutover release has to be converted before it
 * serves a request, or its blocks would silently stop applying.
 *
 * The migration is idempotent (a project with a published generation is
 * skipped), so this is a no-op on every boot after the first, and it is
 * TEMPORARY — `services/policy-legacy-migration/README.md` carries the removal
 * checklist. The guard runs after it as an assertion: anything still carrying
 * legacy rules with no materialized v2 policy is reported loudly.
 *
 * Every EE edition aliases this file away for its own seam, so neither the
 * conversion nor the guard runs there: cloud was converted in 2026-07 and has
 * nothing left to carry over. This path is what a self-hosted OSS instance
 * upgrading across the cutover relies on.
 */
export const runPolicyMigration = async (): Promise<void> => {
  await runLegacyPolicyMigration();
  await guardUnmigratedPolicy();
};
