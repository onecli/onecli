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

export const getRules = async () => {
  const { accountId } = await resolveUser();
  return listPolicyRules(accountId);
};

export const createRule = async (input: CreatePolicyRuleInput) => {
  const { accountId } = await resolveUser();
  return createPolicyRuleService(accountId, input);
};

export const updateRule = async (
  ruleId: string,
  input: UpdatePolicyRuleInput,
) => {
  const { accountId } = await resolveUser();
  return updatePolicyRuleService(accountId, ruleId, input);
};

export const deleteRule = async (ruleId: string) => {
  const { accountId } = await resolveUser();
  return deletePolicyRuleService(accountId, ruleId);
};
