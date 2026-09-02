import { db } from "@onecli/db";
import type { RuleActionGate, RuleWriteScope } from "../../providers";
import {
  ruleActionFeature,
  type PremiumFeature,
} from "../billing/plan-features";
import { assertFeatureAllowed } from "../services/quota-service";

const resolveOrganizationId = async (
  scope: RuleWriteScope,
): Promise<string | null> => {
  if (scope.organizationId) return scope.organizationId;
  if (scope.workspaceId) {
    const workspace = await db.workspace.findUnique({
      where: { id: scope.workspaceId },
      select: { organizationId: true },
    });
    return workspace?.organizationId ?? null;
  }
  return null;
};

/**
 * Cloud: gate paid-only policy-rule actions (`manual_approval`, `rate_limit`)
 * behind their required plan. `block`/`allow` map to no feature and pass
 * through. Resolves the org from workspace or org scope.
 */
export const eeRuleActionGate: RuleActionGate = {
  async assertAllowed(scope, actions) {
    const features = [...new Set(actions)]
      .map(ruleActionFeature)
      .filter((f): f is PremiumFeature => f !== null);
    if (features.length === 0) return;

    const organizationId = await resolveOrganizationId(scope);
    if (!organizationId) return;

    for (const feature of features) {
      await assertFeatureAllowed(organizationId, feature);
    }
  },
};
