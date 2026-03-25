"use server";

import { resolveUser } from "@/lib/actions/resolve-user";
import {
  listPolicyRules,
  createPolicyRule as createPolicyRuleService,
  updatePolicyRule as updatePolicyRuleService,
  deletePolicyRule as deletePolicyRuleService,
  type CreatePolicyRuleInput,
  type UpdatePolicyRuleInput,
} from "@/lib/services/policy-rule-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@/lib/services/audit-service";

export const getRules = async () => {
  const { accountId } = await resolveUser();
  return listPolicyRules(accountId);
};

export const createRule = async (input: CreatePolicyRuleInput) => {
  const { userId, userEmail, accountId } = await resolveUser();
  return withAudit(
    () => createPolicyRuleService(accountId, input),
    (rule) => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.RULE,
      metadata: { ruleId: rule.id, name: input.name, action: input.action },
    }),
  );
};

export const updateRule = async (
  ruleId: string,
  input: UpdatePolicyRuleInput,
): Promise<void> => {
  const { userId, userEmail, accountId } = await resolveUser();
  return withAudit(
    () => updatePolicyRuleService(accountId, ruleId, input),
    () => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.RULE,
      metadata: { ruleId },
    }),
  );
};

export const deleteRule = async (ruleId: string): Promise<void> => {
  const { userId, userEmail, accountId } = await resolveUser();
  return withAudit(
    () => deletePolicyRuleService(accountId, ruleId),
    () => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.RULE,
      metadata: { ruleId },
    }),
  );
};
