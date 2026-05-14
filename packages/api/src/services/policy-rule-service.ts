import { db } from "@onecli/db";
import { ServiceError } from "./errors";
import {
  type CreatePolicyRuleInput,
  type UpdatePolicyRuleInput,
} from "../validations/policy-rule";
import type { AppTool, AppPermissionLevel } from "../apps/app-permissions";

export type { CreatePolicyRuleInput, UpdatePolicyRuleInput };

export const listPolicyRules = async (projectId: string) => {
  return db.policyRule.findMany({
    where: { projectId },
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
      scope: true,
      metadata: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
};

export const createPolicyRule = async (
  projectId: string,
  input: CreatePolicyRuleInput,
) => {
  const name = input.name.trim();

  // Validate agent belongs to account if specified
  if (input.agentId) {
    const agent = await db.agent.findFirst({
      where: { id: input.agentId, projectId },
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
      scope: "project",
      projectId,
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
  projectId: string,
  ruleId: string,
  input: UpdatePolicyRuleInput,
) => {
  const rule = await db.policyRule.findFirst({
    where: { id: ruleId, projectId },
    select: { id: true },
  });

  if (!rule) throw new ServiceError("NOT_FOUND", "Policy rule not found");

  // Validate agent belongs to account if changing agentId
  if (input.agentId) {
    const agent = await db.agent.findFirst({
      where: { id: input.agentId, projectId },
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
  if (input.agentId !== undefined) data.agentId = input.agentId || null;
  if (input.rateLimit !== undefined) data.rateLimit = input.rateLimit;
  if (input.rateLimitWindow !== undefined)
    data.rateLimitWindow = input.rateLimitWindow;

  await db.policyRule.update({
    where: { id: ruleId },
    data,
  });
};

export const deletePolicyRule = async (projectId: string, ruleId: string) => {
  const rule = await db.policyRule.findFirst({
    where: { id: ruleId, projectId },
    select: { id: true },
  });

  if (!rule) throw new ServiceError("NOT_FOUND", "Policy rule not found");

  await db.policyRule.delete({ where: { id: ruleId } });
};

export const listAppPermissionRules = async (
  projectId: string,
  provider: string,
) => {
  return db.policyRule.findMany({
    where: {
      projectId,
      AND: [
        { metadata: { path: ["source"], equals: "app_permission" } },
        { metadata: { path: ["provider"], equals: provider } },
      ],
    },
    select: {
      id: true,
      action: true,
      metadata: true,
    },
  });
};

export interface AppPermissionChange {
  toolId: string;
  permission: AppPermissionLevel;
  tool: AppTool;
}

export const setAppPermissionsService = async (
  projectId: string,
  provider: string,
  appName: string,
  changes: AppPermissionChange[],
) => {
  const existing = await listAppPermissionRules(projectId, provider);
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

  for (const change of changes) {
    const existingRule = existingByToolId.get(change.toolId);

    if (change.permission === "allow") {
      if (existingRule) toDelete.push(existingRule.id);
    } else if (existingRule) {
      if (existingRule.action !== change.permission) {
        toUpdate.push({ ruleId: existingRule.id, action: change.permission });
      }
    } else {
      toCreate.push(change);
    }
  }

  await db.$transaction(async (tx) => {
    if (toDelete.length > 0) {
      await tx.policyRule.deleteMany({
        where: { id: { in: toDelete }, projectId },
      });
    }

    for (const update of toUpdate) {
      await tx.policyRule.update({
        where: { id: update.ruleId },
        data: { action: update.action },
      });
    }

    for (const create of toCreate) {
      await tx.policyRule.create({
        data: {
          projectId,
          scope: "project",
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
  projectId: string,
  hostPatterns: string[],
) => {
  if (hostPatterns.length === 0) return 0;
  return db.policyRule.count({
    where: {
      projectId,
      enabled: true,
      hostPattern: { in: hostPatterns },
      NOT: {
        metadata: { path: ["source"], equals: "app_permission" },
      },
    },
  });
};
