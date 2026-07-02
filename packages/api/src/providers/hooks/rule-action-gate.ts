/** Scope of a policy-rule write. Structurally compatible with `ResourceScope`. */
export interface RuleWriteScope {
  projectId?: string;
  organizationId?: string;
}

/**
 * Authorizes which policy-rule actions an org may write. The OSS default allows
 * everything; the cloud edition injects a plan-based implementation via `createApiApp`.
 *
 * Called by the policy-rule service itself, so every write path — HTTP routes,
 * server actions, project scope and org scope — is gated in one place and no
 * caller can bypass it.
 */
export interface RuleActionGate {
  assertAllowed(scope: RuleWriteScope, actions: string[]): Promise<void>;
}

const defaultRuleActionGate: RuleActionGate = {
  assertAllowed: async () => {},
};

let _ruleActionGate: RuleActionGate = defaultRuleActionGate;

export const initRuleActionGate = (a: RuleActionGate) => {
  _ruleActionGate = a;
};

export const getRuleActionGate = (): RuleActionGate => _ruleActionGate;
