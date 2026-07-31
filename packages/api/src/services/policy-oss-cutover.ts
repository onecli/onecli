/**
 * The OSS new-project policy seeder (wired via the OSS init seam). Since step 10
 * the legacy→v2 cutover machinery is gone; this file keeps only the v2-native
 * seeder that gives a fresh project its published Default Rule.
 */
import { backfillPublishScope, type BackfillRuleInput } from "./policy-service";

/** The seeded per-project Default Rule. Priority is assigned by the caller. */
const ossProjectDefaultRule = (): BackfillRuleInput => ({
  priority: 0,
  isDefault: true,
  source: "default",
  name: "Default Rule",
  action: "allow",
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  identities: [],
  targets: [],
});

/**
 * Seed a fresh project's published Default Rule as ALLOW, always — the project
 * enforces v2 from birth (the published generation is the gateway's per-project
 * enforce signal). Org-only calls no-op: OSS has no org scope.
 *
 * It used to derive a posture from the OLDEST project's published default, so a
 * deny-by-default instance would keep minting deny-by-default projects. That
 * inverted at attach-model step 6: the project Default Rule has no UI any more,
 * so an inherited Block would be invisible AND unfixable — every project would
 * silently be allowlist-mode with nothing to show or change it. Access at
 * project level is expressed by agent credential grants now; a project's
 * terminal rule is not a posture dial.
 */
export const ossNewProjectPolicySeeder = {
  seed: async (_organizationId: string, projectId?: string): Promise<void> => {
    if (!projectId) return;
    await backfillPublishScope({ projectId }, [ossProjectDefaultRule()]);
  },
};
