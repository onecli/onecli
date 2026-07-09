import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from "./client";
import type { PageScope } from "./scope";
import type { PolicyRule, CreateRuleInput, UpdateRuleInput } from "./types";
import type { AppPermissionSetting } from "@onecli/api/apps/app-permissions";
import type {
  AppPermissionStatesResult,
  setAppPermissionsService,
} from "@onecli/api/services/policy-rule-service";

const rulesPath = (scope: PageScope, sub = "") =>
  scope === "organization" ? `/v1/org/rules${sub}` : `/v1/rules${sub}`;

export const list = (scope: PageScope = "project") =>
  apiGet<PolicyRule[]>(rulesPath(scope));

export const create = (input: CreateRuleInput, scope: PageScope = "project") =>
  apiPost<PolicyRule>(rulesPath(scope), input);

export const update = (
  ruleId: string,
  input: UpdateRuleInput,
  scope: PageScope = "project",
) => apiPatch<{ success: true }>(rulesPath(scope, `/${ruleId}`), input);

export const remove = (ruleId: string, scope: PageScope = "project") =>
  apiDelete(rulesPath(scope, `/${ruleId}`));

export interface SetAppPermissionsInput {
  changes: { toolId: string; permission: AppPermissionSetting }[];
  conditions?: unknown[];
  /** Project scope only: target one agent's override layer. */
  agentId?: string;
}

export const permissionStates = (
  provider: string,
  scope: PageScope = "project",
) =>
  apiGet<AppPermissionStatesResult>(
    rulesPath(scope, `/permissions/${provider}`),
  );

export const setPermissions = (
  provider: string,
  input: SetAppPermissionsInput,
  scope: PageScope = "project",
) =>
  apiPut<Awaited<ReturnType<typeof setAppPermissionsService>>>(
    rulesPath(scope, `/permissions/${provider}`),
    input,
  );

export const overlapCount = (provider: string, scope: PageScope = "project") =>
  apiGet<{ count: number }>(rulesPath(scope, `/overlap/${provider}`));
