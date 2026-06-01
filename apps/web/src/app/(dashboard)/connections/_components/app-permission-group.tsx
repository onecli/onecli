"use client";

import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@onecli/ui/components/accordion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import type {
  AppToolGroup,
  AppPermissionLevel,
} from "@onecli/api/apps/app-permissions";
import type { RuleCondition } from "@onecli/api/validations/policy-rule";
import type { AppPermissionState } from "@/lib/actions/rules";
import {
  isToolFullyLocked,
  resolveToolPermission,
} from "./resolve-tool-permission";
import { AppPermissionRow } from "./app-permission-row";

interface AppPermissionGroupProps {
  group: AppToolGroup;
  permissionStates: Record<string, AppPermissionState>;
  onPermissionChange: (toolId: string, permission: AppPermissionLevel) => void;
  onGroupChange: (permission: AppPermissionLevel) => void;
  disabled?: boolean;
  orgStates?: Record<string, AppPermissionLevel>;
  orgConditions?: Record<string, unknown[]>;
  defaultPermission?: AppPermissionLevel;
}

const groupLabels: Record<string, string> = {
  read: "Read-only",
  write: "Write / delete",
};

const permissionLabels: Record<string, string> = {
  allow: "Always allow",
  manual_approval: "Needs approval",
  block: "Block",
};

const getGroupPermission = (
  tools: AppToolGroup["tools"],
  states: Record<string, AppPermissionState>,
  fallback: AppPermissionLevel = "allow",
): AppPermissionLevel | "custom" => {
  const permissions = tools.map((t) => states[t.id]?.permission ?? fallback);
  const first = permissions[0];
  if (first === undefined) return fallback;
  return permissions.every((p) => p === first) ? first : "custom";
};

export const AppPermissionGroup = ({
  group,
  permissionStates,
  onPermissionChange,
  onGroupChange,
  disabled,
  orgStates,
  orgConditions,
  defaultPermission = "allow",
}: AppPermissionGroupProps) => {
  const groupPerm = getGroupPermission(
    group.tools,
    permissionStates,
    defaultPermission,
  );

  const isGroupOptionDisabled = (opt: AppPermissionLevel) =>
    group.tools.some((t) =>
      resolveToolPermission(
        permissionStates[t.id]?.permission ?? defaultPermission,
        [],
        orgStates?.[t.id],
        (orgConditions?.[t.id] ?? []) as RuleCondition[],
      ).isOptionDisabled(opt),
    );

  const allOrgEnforced =
    orgStates != null &&
    group.tools.every((t) =>
      isToolFullyLocked(
        orgStates[t.id],
        (orgConditions?.[t.id] ?? []) as RuleCondition[],
      ),
    );

  return (
    <AccordionItem value={group.category} className="border-b-0">
      <div className="flex items-center justify-between">
        <AccordionTrigger className="py-3 hover:no-underline">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {groupLabels[group.category] ?? group.category}
            </span>
            <span className="text-xs text-muted-foreground rounded-full bg-muted px-1.5 py-0.5 font-medium">
              {group.tools.length}
            </span>
          </div>
        </AccordionTrigger>
        <Select
          value={groupPerm === "custom" ? "custom" : groupPerm}
          onValueChange={(v) => {
            if (v !== "custom") {
              onGroupChange(v as AppPermissionLevel);
            }
          }}
          disabled={disabled || allOrgEnforced}
        >
          <SelectTrigger className="h-7 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:text-foreground focus:ring-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {groupPerm === "custom" && (
              <SelectItem value="custom" disabled>
                Custom
              </SelectItem>
            )}
            {Object.entries(permissionLabels).map(([value, label]) => (
              <SelectItem
                key={value}
                value={value}
                disabled={isGroupOptionDisabled(value as AppPermissionLevel)}
              >
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <AccordionContent className="pb-2">
        <div className="ml-6">
          {group.tools.map((tool) => {
            const state = permissionStates[tool.id];
            const permission = state?.permission ?? defaultPermission;
            const projectConditions = (state?.conditions ??
              []) as RuleCondition[];
            const toolOrgConditions = (orgConditions?.[tool.id] ??
              []) as RuleCondition[];
            return (
              <AppPermissionRow
                key={tool.id}
                tool={tool}
                permission={permission}
                conditions={projectConditions}
                onPermissionChange={(perm) => onPermissionChange(tool.id, perm)}
                disabled={disabled}
                orgPermission={orgStates?.[tool.id]}
                orgConditions={toolOrgConditions}
              />
            );
          })}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
};
