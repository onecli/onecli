import type { NewOrgPolicySeeder } from "../../providers";
import {
  backfillPublishScope,
  type BackfillRuleInput,
} from "../../services/policy-service";

// ── Cloud new-org policy seed ───────────────────────────────────────────────
// A brand-new org starts OPEN: a single published org Default Rule with
// action=allow (the attach-model posture, plans/project-attach-model.md — new
// users connect an app, attach it to an agent, and it works; nothing is
// silently blocked from birth). Deny-by-default is the opt-in stance: an org
// admin flips this Default Rule to Block in the org Policy console, and from
// then on credentialed non-LLM traffic needs explicit allows (the engine's
// deny-default carve). Orgs seeded before this flip keep the Block they were
// born with — the seeder never rewrites an existing generation.
//
// Written through `backfillPublishScope`, so it is idempotent (a no-op once the
// org has a published generation) and cannot clobber a later edit.

const ALLOW_DEFAULT: BackfillRuleInput = {
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
};

export const eeNewOrgPolicySeeder: NewOrgPolicySeeder = {
  seed: async (organizationId: string) => {
    await backfillPublishScope({ organizationId }, [ALLOW_DEFAULT]);
  },
};
