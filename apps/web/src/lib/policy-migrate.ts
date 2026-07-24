import { policyEditingEnabled } from "@onecli/api/lib/policy-flags";

/**
 * The OSS boot seam — since step 9.5, the REAL release-as-cutover pass: every
 * boot translates any not-yet-cut project's legacy policy state (custom rules
 * + app-permission rows + blocklist + equipment + the org-row `policyMode`)
 * into one atomic published v2 generation, verifies it, and runs the
 * blocklist/equipment bridge sweep. Idempotent (published-generation
 * skip-if-done); the published generation is the gateway's per-project enable
 * signal, so backfill → verify → enforce is structural.
 *
 * The EE editions (cloud + both onprems) swap this file for the EE backfill
 * (`@/ee/policy-migrate`) via `resolveAlias`; instrumentation calls the seam
 * unconditionally and each impl self-gates on the editing flag —
 * `POLICY_EDITING_ENABLED=0` is the OSS operator rollback (pure legacy, this
 * pass no-ops).
 */
export const runPolicyMigration = async (): Promise<void> => {
  if (!policyEditingEnabled()) return;
  const { runOssPolicyCutover } =
    await import("@onecli/api/services/policy-oss-cutover");
  await runOssPolicyCutover();
};
