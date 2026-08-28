import { failMissingCloudDefault } from "../edition-state";

// ── New-org policy seed (edition default) ───────────────────────────────────
// When a new organization is bootstrapped, seed its published `policy_rules_v2`
// so the engine has a posture from birth. Cloud seeds an org Default Rule with
// action=allow (the attach-model posture — new orgs start open; an org admin
// opts into deny-by-default by flipping the rule to Block in the org Policy
// console). Onprem seeds the org's freshly-created default WORKSPACE's Default
// Rule instead (pinned to allow since step 6).
//
// BOTH edition impls import policy-service (and through it the DB client), so
// neither may be a static import here — this provider is reachable from client
// bundles via the providers barrel. `ensureEditionDefaults()` injects the
// running edition's seeder on every server boot path.
//
// Deliberately NOT built on `createEditionSlot`: that factory models an
// injected CLOUD default over a static onprem one, while this seam has both
// arms injected — an uninjected read fails loudly in EITHER edition (the
// failMissingCloudDefault message covers both "never ran" and "injector
// missing").

export interface NewOrgPolicySeeder {
  /** Seed the new org's initial published policy. Idempotent — a no-op once
   * the scope already has a published generation. `workspaceId` is the org's
   * freshly-created default workspace: the onprem seeder (step 9.5) seeds THAT
   * workspace's Default Rule, pinned to allow since step 6 (onprem has no org
   * scope); the cloud seeder ignores it and seeds the org scope. */
  seed(organizationId: string, workspaceId?: string): Promise<void>;
}

let _seeder: NewOrgPolicySeeder | null = null;

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultNewOrgPolicySeeder = (s: NewOrgPolicySeeder) => {
  _seeder = s;
};

export const getNewOrgPolicySeeder = (): NewOrgPolicySeeder =>
  _seeder ?? failMissingCloudDefault("newOrgPolicySeeder");
