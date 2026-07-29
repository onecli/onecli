import type { CreateApiAppOptions } from "@onecli/api";
import { ossNewProjectPolicySeeder } from "@onecli/api/services/policy-oss-cutover";
import { ossPolicyValidator } from "@onecli/api/services/policy-oss-locks";

/**
 * The OSS edition's API wiring. Every EE edition ALIASES THIS FILE AWAY
 * (`next.config.js` → `@/ee/init/api` or `@/ee/onprem/init/api`), so anything
 * here is OSS-only by construction:
 *
 * - the new-project seeder gives fresh projects their published Default Rule —
 *   the per-project enforce signal — pinned to ALLOW since step 6;
 * - the policy validator LOCKS granular resource scoping (a OneCLI Cloud
 *   capability the OSS gateway does not enforce) with a loud 422.
 */
export const eeOverrides: CreateApiAppOptions | undefined = {
  newOrgPolicySeeder: ossNewProjectPolicySeeder,
  policyValidator: ossPolicyValidator,
};
