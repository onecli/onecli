import type { AppPermissionLevel } from "@onecli/api/apps/app-permissions";
import type { RuleCondition } from "@onecli/api/validations/policy-rule";

const STRICTNESS: Record<AppPermissionLevel, number> = {
  allow: 0,
  manual_approval: 1,
  block: 2,
};

const ACTION_LABELS: Record<AppPermissionLevel, string> = {
  allow: "Allowed",
  block: "Blocked",
  manual_approval: "Needs approval",
};

const getOrgContext = (
  orgPermission?: AppPermissionLevel,
  orgConditions?: RuleCondition[],
) => {
  const level = STRICTNESS[orgPermission ?? "allow"];
  const hasRule = orgPermission != null && orgPermission !== "allow";
  const isConditional = hasRule && (orgConditions?.length ?? 0) > 0;
  const isUnconditionalBlock =
    hasRule && !isConditional && orgPermission === "block";

  return { level, hasRule, isConditional, isUnconditionalBlock };
};

export interface ResolvedToolPermission {
  effectivePermission: AppPermissionLevel;
  displayConditions: RuleCondition[];
  isFullyLocked: boolean;
  isOptionDisabled: (option: AppPermissionLevel) => boolean;
  orgLine: string | null;
}

export const resolveToolPermission = (
  projectPermission: AppPermissionLevel,
  projectConditions: RuleCondition[],
  orgPermission?: AppPermissionLevel,
  orgConditions?: RuleCondition[],
): ResolvedToolPermission => {
  const org = getOrgContext(orgPermission, orgConditions);
  const projectLevel = STRICTNESS[projectPermission];

  if (!org.hasRule) {
    return {
      effectivePermission: projectPermission,
      displayConditions: projectConditions,
      isFullyLocked: false,
      isOptionDisabled: () => false,
      orgLine: null,
    };
  }

  if (org.isConditional) {
    const condValue = orgConditions?.[0]?.value;
    const label = ACTION_LABELS[orgPermission!];
    return {
      effectivePermission: projectPermission,
      displayConditions: projectConditions,
      isFullyLocked: false,
      isOptionDisabled: () => false,
      orgLine: condValue
        ? `Org: ${label} when body contains "${condValue}"`
        : `Org: ${label} (conditional)`,
    };
  }

  if (org.isUnconditionalBlock) {
    return {
      effectivePermission: "block",
      displayConditions: [],
      isFullyLocked: true,
      isOptionDisabled: () => true,
      orgLine: null,
    };
  }

  // Unconditional org approval — sets a floor
  const effective =
    projectLevel >= org.level ? projectPermission : orgPermission!;
  return {
    effectivePermission: effective,
    displayConditions: projectConditions,
    isFullyLocked: false,
    isOptionDisabled: (opt) => STRICTNESS[opt] < org.level,
    orgLine: `Org minimum: ${ACTION_LABELS[orgPermission!]}`,
  };
};

export const isToolFullyLocked = (
  orgPermission?: AppPermissionLevel,
  orgConditions?: RuleCondition[],
): boolean => getOrgContext(orgPermission, orgConditions).isUnconditionalBlock;
