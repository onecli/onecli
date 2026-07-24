import type { CreateApiAppOptions } from "@onecli/api";
import { ossPolicyCoherenceBridge } from "@onecli/api/services/policy-oss-bridge";
import { ossNewProjectPolicySeeder } from "@onecli/api/services/policy-oss-cutover";
import { ossPolicyValidator } from "@onecli/api/services/policy-oss-locks";

/**
 * The OSS edition's API wiring (step 9.5). Every EE edition ALIASES THIS FILE
 * AWAY (`next.config.js` → `@/ee/init/api` or `@/ee/onprem/init/api`), so
 * anything here is OSS-only by construction:
 *
 * - the coherence bridge keeps blocklist/equipment writes flowing into the v2
 *   generation (the legacy editors stay live until step 10);
 * - the new-project seeder gives fresh projects their published Default Rule
 *   (the per-project cutover signal) from the instance posture;
 * - the policy validator LOCKS granular resource scoping (a OneCLI Cloud
 *   capability the OSS gateway does not enforce) with a loud 422.
 */
export const eeOverrides: CreateApiAppOptions | undefined = {
  policyCoherenceBridge: ossPolicyCoherenceBridge,
  newOrgPolicySeeder: ossNewProjectPolicySeeder,
  policyValidator: ossPolicyValidator,
};
