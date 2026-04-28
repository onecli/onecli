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
  const { projectId } = await resolveUser();
  return listPolicyRules(projectId);
};

export const createRule = async (input: CreatePolicyRuleInput) => {
  const { userId, userEmail, projectId } = await resolveUser();
  return withAudit(
    () => createPolicyRuleService(projectId, input),
    (rule) => ({
      projectId,
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
  const { userId, userEmail, projectId } = await resolveUser();
  return withAudit(
    () => updatePolicyRuleService(projectId, ruleId, input),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.RULE,
      metadata: { ruleId },
    }),
  );
};

export const deleteRule = async (ruleId: string): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveUser();
  return withAudit(
    () => deletePolicyRuleService(projectId, ruleId),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.RULE,
      metadata: { ruleId },
    }),
  );
};
