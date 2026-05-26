"use server";

import { resolveProjectContext } from "@/lib/actions/resolve-user";
import {
  listPolicyRules,
  createPolicyRule as createPolicyRuleService,
  updatePolicyRule as updatePolicyRuleService,
  deletePolicyRule as deletePolicyRuleService,
  listAppPermissionRules,
  setAppPermissionsService,
  countOverlappingRulesForHost,
  type CreatePolicyRuleInput,
  type UpdatePolicyRuleInput,
} from "@onecli/api/services/policy-rule-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";
import {
  getAppPermissionDefinition,
  type AppPermissionLevel,
} from "@onecli/api/apps/app-permissions";
import type { RuleCondition } from "@onecli/api/validations/policy-rule";

export const getRules = async () => {
  const { projectId } = await resolveProjectContext();
  return listPolicyRules({ projectId });
};

export const createRule = async (input: CreatePolicyRuleInput) => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => createPolicyRuleService({ projectId }, input),
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
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => updatePolicyRuleService({ projectId }, ruleId, input),
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
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => deletePolicyRuleService({ projectId }, ruleId),
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

export type AppPermissionState = {
  permission: AppPermissionLevel;
  conditions: unknown[];
};

export const getAppPermissionStates = async (
  provider: string,
): Promise<Record<string, AppPermissionState>> => {
  const { projectId } = await resolveProjectContext();
  const rules = await listAppPermissionRules({ projectId }, provider);

  const states: Record<string, AppPermissionState> = {};
  for (const rule of rules) {
    const meta = rule.metadata as { toolId?: string } | null;
    if (meta?.toolId) {
      states[meta.toolId] = {
        permission: rule.action === "block" ? "block" : "manual_approval",
        conditions: Array.isArray(rule.conditions) ? rule.conditions : [],
      };
    }
  }
  return states;
};

export const setAppPermissions = async (
  provider: string,
  changes: { toolId: string; permission: AppPermissionLevel }[],
  conditions?: RuleCondition[],
): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  const def = getAppPermissionDefinition(provider);
  if (!def)
    throw new Error(`No permission definition for provider: ${provider}`);

  const allTools = def.groups.flatMap((g) => g.tools);
  const toolMap = new Map(allTools.map((t) => [t.id, t]));

  const resolvedChanges = changes.map((c) => {
    const tool = toolMap.get(c.toolId);
    if (!tool) throw new Error(`Unknown tool: ${c.toolId}`);
    return { toolId: c.toolId, permission: c.permission, tool };
  });

  const appName =
    provider.charAt(0).toUpperCase() + provider.slice(1).replace(/-/g, " ");

  await withAudit(
    () =>
      setAppPermissionsService(
        { projectId },
        provider,
        appName,
        resolvedChanges,
        conditions,
      ),
    (result) => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.RULE,
      metadata: {
        source: "app_permission",
        provider,
        changes: changes.map((c) => ({
          toolId: c.toolId,
          permission: c.permission,
        })),
        ...result,
      },
    }),
  );
};

export const getOverlappingRuleCountForApp = async (
  provider: string,
): Promise<number> => {
  const { projectId } = await resolveProjectContext();
  const def = getAppPermissionDefinition(provider);
  if (!def) return 0;
  const hostPatterns = [
    ...new Set(def.groups.flatMap((g) => g.tools.map((t) => t.hostPattern))),
  ];
  return countOverlappingRulesForHost({ projectId }, hostPatterns);
};
