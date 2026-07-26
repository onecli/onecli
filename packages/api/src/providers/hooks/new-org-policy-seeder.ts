// ── New-org policy seed seam ────────────────────────────────────────────────
// When a new organization is bootstrapped, seed its published `policy_rules_v2`
// so the engine has a posture from birth. Cloud seeds a secure-by-default org
// Default Rule (Block, carrying the engine's deny-default carve — it bites only
// on a detected injection to a non-LLM host).
//
// The OSS default is a no-op (OSS has no org scope — its projects are seeded by
// `ossNewProjectPolicySeeder`); the cloud edition injects the real seeder via
// `createApiApp`, like the other EE provider seams.

export interface NewOrgPolicySeeder {
  /** Seed the new org's initial published policy. Idempotent — a no-op once
   * the scope already has a published generation. `projectId` is the org's
   * freshly-created default project: the OSS seeder (step 9.5) seeds THAT
   * project's Default Rule from the instance posture (OSS has no org scope);
   * the cloud seeder ignores it and seeds the org scope as before. */
  seed(organizationId: string, projectId?: string): Promise<void>;
}

const defaultNewOrgPolicySeeder: NewOrgPolicySeeder = {
  seed: async () => {},
};

let _newOrgPolicySeeder: NewOrgPolicySeeder = defaultNewOrgPolicySeeder;

export const initNewOrgPolicySeeder = (s: NewOrgPolicySeeder) => {
  _newOrgPolicySeeder = s;
};

export const getNewOrgPolicySeeder = (): NewOrgPolicySeeder =>
  _newOrgPolicySeeder;
