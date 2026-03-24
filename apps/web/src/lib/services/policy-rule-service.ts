import { db } from "@onecli/db";
import { ServiceError } from "@/lib/services/errors";
import {
  type CreatePolicyRuleInput,
  type UpdatePolicyRuleInput,
} from "@/lib/validations/policy-rule";

export type { CreatePolicyRuleInput, UpdatePolicyRuleInput };

export const listPolicyRules = async (accountId: string) => {
  return db.policyRule.findMany({
    where: { accountId },
    select: {
      id: true,
      name: true,
      hostPattern: true,
      pathPattern: true,
      method: true,
      action: true,
      enabled: true,
      agentId: true,
      rateLimit: true,
      rateLimitWindow: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
};

export const createPolicyRule = async (
  accountId: string,
  input: CreatePolicyRuleInput,
) => {
  const name = input.name.trim();

  // Validate agent belongs to account if specified
  if (input.agentId) {
    const agent = await db.agent.findFirst({
      where: { id: input.agentId, accountId },
      select: { id: true },
    });
    if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  }

  return db.policyRule.create({
    data: {
      name,
      hostPattern: input.hostPattern.trim(),
      pathPattern: input.pathPattern?.trim() || null,
      method: input.method || null,
      action: input.action,
      enabled: input.enabled,
      agentId: input.agentId || null,
      rateLimit:
        input.action === "rate_limit" ? (input.rateLimit ?? null) : null,
      rateLimitWindow:
        input.action === "rate_limit" ? (input.rateLimitWindow ?? null) : null,
      accountId,
    },
    select: {
      id: true,
      name: true,
      hostPattern: true,
      pathPattern: true,
      method: true,
      action: true,
      enabled: true,
      agentId: true,
      rateLimit: true,
      rateLimitWindow: true,
      createdAt: true,
    },
  });
};

export const updatePolicyRule = async (
  accountId: string,
  ruleId: string,
  input: UpdatePolicyRuleInput,
) => {
  const rule = await db.policyRule.findFirst({
    where: { id: ruleId, accountId },
    select: { id: true },
  });

  if (!rule) throw new ServiceError("NOT_FOUND", "Policy rule not found");

  // Validate agent belongs to account if changing agentId
  if (input.agentId) {
    const agent = await db.agent.findFirst({
      where: { id: input.agentId, accountId },
      select: { id: true },
    });
    if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  }

  const data: Record<string, unknown> = {};

  if (input.name !== undefined) data.name = input.name.trim();
  if (input.hostPattern !== undefined)
    data.hostPattern = input.hostPattern.trim();
  if (input.pathPattern !== undefined)
    data.pathPattern = input.pathPattern?.trim() || null;
  if (input.method !== undefined) data.method = input.method || null;
  if (input.action !== undefined) {
    data.action = input.action;
    if (input.action === "block") {
      data.rateLimit = null;
      data.rateLimitWindow = null;
    }
  }
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.agentId !== undefined) data.agentId = input.agentId || null;
  if (input.rateLimit !== undefined) data.rateLimit = input.rateLimit;
  if (input.rateLimitWindow !== undefined)
    data.rateLimitWindow = input.rateLimitWindow;

  await db.policyRule.update({
    where: { id: ruleId },
    data,
  });
};

export const deletePolicyRule = async (accountId: string, ruleId: string) => {
  const rule = await db.policyRule.findFirst({
    where: { id: ruleId, accountId },
    select: { id: true },
  });

  if (!rule) throw new ServiceError("NOT_FOUND", "Policy rule not found");

  await db.policyRule.delete({ where: { id: ruleId } });
};
