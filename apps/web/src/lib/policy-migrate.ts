import { runLegacyPolicyMigration } from "@onecli/api/services/policy-legacy-migration";
import { guardUnmigratedPolicy } from "@onecli/api/services/policy-migration-guard";
import { runGrantConversion } from "@onecli/api/services/policy-grant-conversion";

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
 * The GRANT conversion (attach-model step 5) runs LAST, and the order is
 * load-bearing: an instance jumping across both cutovers in one upgrade first
 * has its legacy grants materialized as equipment rules by the legacy pass,
 * and this same boot then normalizes those into grant stacks and flips every
 * agent to selective. Also idempotent (per agent) and TEMPORARY —
 * `services/policy-grant-conversion/README.md` is its removal checklist.
 *
 * Every EE edition aliases this file away for its own seam (which runs the
 * grant conversion too — cloud/onprem have no legacy rules left, so they skip
 * the legacy pass and the guard's conversion half stays report-only there).
 */
export const runPolicyMigration = async (): Promise<void> => {
  await runLegacyPolicyMigration();
  await guardUnmigratedPolicy();
  await runGrantConversion();
};
