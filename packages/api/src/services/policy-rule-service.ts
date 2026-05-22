import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import type { ResourceScope } from "./resource-scope";
import {
  scopeWhere,
  scopeCreate,
  scopeOwnership,
  isOrgScope,
} from "./resource-scope";
import {
  type CreatePolicyRuleInput,
  type UpdatePolicyRuleInput,
  type RuleCondition,
} from "../validations/policy-rule";
import type { AppTool, AppPermissionLevel } from "../apps/app-permissions";

export type { CreatePolicyRuleInput, UpdatePolicyRuleInput };

const RULE_SELECT = {
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
  scope: true,
  metadata: true,
  conditions: true,
  createdAt: true,
} as const;

export const listPolicyRules = async (scope: ResourceScope) => {
  return db.policyRule.findMany({
    where: scopeWhere(scope),
    select: RULE_SELECT,
    orderBy: { createdAt: "desc" },
  });
};

export const getPolicyRule = async (scope: ResourceScope, ruleId: string) => {
  const rule = await db.policyRule.findFirst({
    where: scopeOwnership(scope, ruleId),
    select: RULE_SELECT,
  });
  if (!rule) throw new ServiceError("NOT_FOUND", "Policy rule not found");
  return rule;
};

export const createPolicyRule = async (
  scope: ResourceScope,
  input: CreatePolicyRuleInput,
) => {
  const name = input.name.trim();
  const orgScope = isOrgScope(scope);

  const agentId = orgScope ? null : input.agentId || null;

  if (agentId && scope.projectId) {
    const agent = await db.agent.findFirst({
      where: { id: agentId, projectId: scope.projectId },
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
      agentId,
      rateLimit:
        input.action === "rate_limit" ? (input.rateLimit ?? null) : null,
      rateLimitWindow:
        input.action === "rate_limit" ? (input.rateLimitWindow ?? null) : null,
      ...(input.conditions ? { conditions: input.conditions } : {}),
      ...scopeCreate(scope),
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
      conditions: true,
      createdAt: true,
    },
  });
};

export const updatePolicyRule = async (
  scope: ResourceScope,
  ruleId: string,
  input: UpdatePolicyRuleInput,
) => {
  const rule = await db.policyRule.findFirst({
    where: scopeOwnership(scope, ruleId),
    select: { id: true },
  });

  if (!rule) throw new ServiceError("NOT_FOUND", "Policy rule not found");

  const orgScope = isOrgScope(scope);

  if (!orgScope && input.agentId) {
    const agent = await db.agent.findFirst({
      where: { id: input.agentId, projectId: scope.projectId! },
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
    if (input.action !== "rate_limit") {
      data.rateLimit = null;
      data.rateLimitWindow = null;
    }
  }
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (!orgScope && input.agentId !== undefined)
    data.agentId = input.agentId || null;
  if (input.rateLimit !== undefined) data.rateLimit = input.rateLimit;
  if (input.rateLimitWindow !== undefined)
    data.rateLimitWindow = input.rateLimitWindow;
  if (input.conditions !== undefined)
    data.conditions =
      input.conditions === null ? Prisma.JsonNull : input.conditions;

  await db.policyRule.update({
    where: { id: ruleId },
    data,
  });
};

export const deletePolicyRule = async (
  scope: ResourceScope,
  ruleId: string,
) => {
  const rule = await db.policyRule.findFirst({
    where: scopeOwnership(scope, ruleId),
    select: { id: true },
  });

  if (!rule) throw new ServiceError("NOT_FOUND", "Policy rule not found");

  await db.policyRule.delete({ where: { id: ruleId } });
};

export const listAppPermissionRules = async (
  scope: ResourceScope,
  provider: string,
) => {
  return db.policyRule.findMany({
    where: {
      ...scopeWhere(scope),
      AND: [
        { metadata: { path: ["source"], equals: "app_permission" } },
        { metadata: { path: ["provider"], equals: provider } },
      ],
    },
    select: {
      id: true,
      action: true,
      metadata: true,
      conditions: true,
    },
  });
};

export interface AppPermissionChange {
  toolId: string;
  permission: AppPermissionLevel;
  tool: AppTool;
}

export const setAppPermissionsService = async (
  scope: ResourceScope,
  provider: string,
  appName: string,
  changes: AppPermissionChange[],
  conditions?: RuleCondition[],
) => {
  const existing = await listAppPermissionRules(scope, provider);
  const existingByToolId = new Map(
    existing
      .filter(
        (r): r is typeof r & { metadata: { toolId: string } } =>
          r.metadata != null &&
          typeof r.metadata === "object" &&
          "toolId" in r.metadata,
      )
      .map((r) => [r.metadata.toolId, r]),
  );

  const toCreate: AppPermissionChange[] = [];
  const toUpdate: { ruleId: string; action: string }[] = [];
  const toDelete: string[] = [];

  const conditionsProvided = conditions !== undefined;

  for (const change of changes) {
    const existingRule = existingByToolId.get(change.toolId);

    if (change.permission === "allow") {
      if (existingRule) toDelete.push(existingRule.id);
    } else if (existingRule) {
      if (existingRule.action !== change.permission || conditionsProvided) {
        toUpdate.push({ ruleId: existingRule.id, action: change.permission });
      }
    } else {
      toCreate.push(change);
    }
  }

  const scopeDeleteWhere = scope.organizationId
    ? { organizationId: scope.organizationId }
    : { projectId: scope.projectId! };

  await db.$transaction(async (tx) => {
    if (toDelete.length > 0) {
      await tx.policyRule.deleteMany({
        where: { id: { in: toDelete }, ...scopeDeleteWhere },
      });
    }

    for (const update of toUpdate) {
      await tx.policyRule.update({
        where: { id: update.ruleId },
        data: {
          action: update.action,
          ...(conditionsProvided
            ? {
                conditions:
                  conditions.length > 0 ? conditions : Prisma.JsonNull,
              }
            : {}),
        },
      });
    }

    for (const create of toCreate) {
      await tx.policyRule.create({
        data: {
          ...scopeCreate(scope),
          agentId: isOrgScope(scope) ? null : undefined,
          name: `${appName}: ${create.tool.name}`,
          hostPattern: create.tool.hostPattern,
          pathPattern: create.tool.pathPattern,
          method: create.tool.method ?? null,
          action: create.permission,
          enabled: true,
          metadata: {
            source: "app_permission",
            provider,
            toolId: create.toolId,
          },
          ...(conditionsProvided && conditions.length > 0
            ? { conditions }
            : {}),
        },
      });
    }
  });

  return {
    created: toCreate.length,
    updated: toUpdate.length,
    deleted: toDelete.length,
  };
};

export const countOverlappingRulesForHost = async (
  scope: ResourceScope,
  hostPatterns: string[],
) => {
  if (hostPatterns.length === 0) return 0;
  return db.policyRule.count({
    where: {
      ...scopeWhere(scope),
      enabled: true,
      hostPattern: { in: hostPatterns },
      NOT: {
        metadata: { path: ["source"], equals: "app_permission" },
      },
    },
  });
};
