"use server";

import { resolveUserId } from "@/lib/actions/resolve-user";
import {
  listPolicyRules,
  createPolicyRule as createPolicyRuleService,
  updatePolicyRule as updatePolicyRuleService,
  deletePolicyRule as deletePolicyRuleService,
  type CreatePolicyRuleInput,
  type UpdatePolicyRuleInput,
} from "@/lib/services/policy-rule-service";

export const getRules = async () => {
  const userId = await resolveUserId();
  return listPolicyRules(userId);
};

export const createRule = async (input: CreatePolicyRuleInput) => {
  const userId = await resolveUserId();
  return createPolicyRuleService(userId, input);
};

export const updateRule = async (
  ruleId: string,
  input: UpdatePolicyRuleInput,
) => {
  const userId = await resolveUserId();
  return updatePolicyRuleService(userId, ruleId, input);
};

export const deleteRule = async (ruleId: string) => {
  const userId = await resolveUserId();
  return deletePolicyRuleService(userId, ruleId);
};
