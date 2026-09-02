import { createEditionSlot } from "../edition-state";
import { assertEntitled } from "../../lib/entitlements-guard";
import type { ResourceScope } from "../../services/resource-scope";

/** Scope of a policy-rule write — the same shape as `ResourceScope`. */
export type RuleWriteScope = ResourceScope;

/**
 * Authorizes which policy-rule actions an org may write. The onprem default
 * gates the group-identity arm behind the enterprise entitlement (#51 — the
 * only licensed rule action; approvals/rate-limit/deny stay free on
 * self-host); the cloud default is the plan-based gate — injected by
 * `ensureEditionDefaults()`, keeping the quota/plan service (and its Redis
 * client) out of client bundles. The `ruleActionGate` option and
 * `initRuleActionGate` remain as overrides for tests (null resets to the
 * edition default).
 *
 * Called by the policy-rule service itself, so every write path — HTTP routes,
 * server actions, workspace scope and org scope — is gated in one place and no
 * caller can bypass it.
 */
export interface RuleActionGate {
  assertAllowed(scope: RuleWriteScope, actions: string[]): Promise<void>;
}

const onpremRuleActionGate: RuleActionGate = {
  assertAllowed: async (_scope, actions) => {
    // Only the GROUP arm of identity targeting is licensed on self-host —
    // rules naming individual users stay free ("identity_directory" alone,
    // which cloud gates by plan, deliberately passes here).
    if (actions.includes("identity_directory_group")) {
      assertEntitled("groups");
    }
  },
};

const slot = createEditionSlot<RuleActionGate>(
  "ruleActionGate",
  onpremRuleActionGate,
);

export const initRuleActionGate = (a: RuleActionGate | null) => slot.init(a);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultRuleActionGate = (a: RuleActionGate) =>
  slot.setCloudDefault(a);

export const getRuleActionGate = (): RuleActionGate => slot.get();
