/**
 * The onprem new-workspace policy seeder — the edition DEFAULT for the
 * `newOrgPolicySeeder` provider hook (cloud's default is
 * `eeNewOrgPolicySeeder`). Since step 10 the legacy→v2 cutover machinery is
 * gone; this file keeps only the v2-native seeder that gives a fresh workspace
 * its published Default Rule.
 */
import { backfillPublishScope, type BackfillRuleInput } from "./policy-service";

/** The seeded per-workspace Default Rule. Priority is assigned by the caller. */
const onpremWorkspaceDefaultRule = (): BackfillRuleInput => ({
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
 * Seed a fresh workspace's published Default Rule as ALLOW, always — the workspace
 * enforces v2 from birth (the published generation is the gateway's per-workspace
 * enforce signal). Org-only calls no-op: onprem seeds the workspace scope; org policy starts empty.
 *
 * It used to derive a posture from the OLDEST workspace's published default, so a
 * deny-by-default instance would keep minting deny-by-default workspaces. That
 * inverted at attach-model step 6: the workspace Default Rule has no UI any more,
 * so an inherited Block would be invisible AND unfixable — every workspace would
 * silently be allowlist-mode with nothing to show or change it. Access at
 * workspace level is expressed by agent credential grants now; a workspace's
 * terminal rule is not a posture dial.
 */
export const onpremNewWorkspacePolicySeeder = {
  seed: async (
    _organizationId: string,
    workspaceId?: string,
  ): Promise<void> => {
    if (!workspaceId) return;
    await backfillPublishScope({ workspaceId }, [onpremWorkspaceDefaultRule()]);
  },
};
