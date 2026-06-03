"use client";

import { Layers } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
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
import { permissionOptions, PermissionButtons } from "./permission-buttons";

interface AppPermissionGroupProps {
  group: AppToolGroup;
  permissionStates: Record<string, AppPermissionState>;
  onPermissionChange: (toolId: string, permission: AppPermissionLevel) => void;
  onGroupChange: (permission: AppPermissionLevel) => void;
  onWildcardReset?: () => void;
  onCoveredPermissionChange?: (
    toolId: string,
    permission: AppPermissionLevel,
  ) => void;
  disabled?: boolean;
  orgStates?: Record<string, AppPermissionLevel>;
  orgConditions?: Record<string, unknown[]>;
  defaultPermission?: AppPermissionLevel;
}

const groupLabels: Record<string, string> = {
  read: "Read-only",
  write: "Write / delete",
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
  onWildcardReset,
  onCoveredPermissionChange,
  disabled,
  orgStates,
  orgConditions,
  defaultPermission = "allow",
}: AppPermissionGroupProps) => {
  const { wildcard } = group;
  const wildcardPermission = wildcard
    ? permissionStates[wildcard.id]?.permission
    : undefined;
  const isWildcardActive =
    wildcardPermission != null && wildcardPermission !== defaultPermission;

  const wildcardResolved = wildcard
    ? resolveToolPermission(
        wildcardPermission ?? defaultPermission,
        [],
        orgStates?.[wildcard.id],
        (orgConditions?.[wildcard.id] ?? []) as RuleCondition[],
      )
    : null;
  const wildcardLocked = wildcardResolved?.isFullyLocked ?? false;

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
            {permissionOptions.map((opt) => (
              <SelectItem
                key={opt.value}
                value={opt.value}
                disabled={isGroupOptionDisabled(opt.value)}
              >
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <AccordionContent className="pb-2">
        <div className="ml-6">
          {wildcard && (
            <div
              className={cn(
                "flex items-center gap-3 py-2.5 border-b border-border/50 -mx-3 px-3 rounded-lg transition-colors",
                !wildcardLocked && "hover:bg-muted",
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <Layers
                    className={cn(
                      "size-3.5 shrink-0",
                      isWildcardActive
                        ? "text-brand"
                        : "text-muted-foreground/40",
                    )}
                  />
                  <p
                    className={cn(
                      "text-sm transition-colors",
                      isWildcardActive
                        ? "font-medium"
                        : "text-muted-foreground",
                    )}
                  >
                    {wildcard.name}
                  </p>
                </div>
              </div>
              <div
                className={cn(
                  "flex items-center gap-1 shrink-0",
                  wildcardLocked && "opacity-50",
                )}
              >
                {isWildcardActive && onWildcardReset && (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={onWildcardReset}
                          disabled={disabled}
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 px-1.5"
                        >
                          Clear
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        Remove and configure each endpoint individually
                      </TooltipContent>
                    </Tooltip>
                    <div className="w-px h-4 bg-border mx-0.5" />
                  </>
                )}
                <PermissionButtons
                  activePermission={
                    isWildcardActive ? wildcardPermission : null
                  }
                  onSelect={(perm) => {
                    if (perm === defaultPermission && !isWildcardActive) {
                      onGroupChange(perm);
                    } else {
                      onPermissionChange(wildcard.id, perm);
                    }
                  }}
                  isOptionDisabled={wildcardResolved?.isOptionDisabled}
                  disabled={disabled}
                />
              </div>
            </div>
          )}
          {group.tools.map((tool) => {
            const state = permissionStates[tool.id];
            const permission = isWildcardActive
              ? wildcardPermission
              : (state?.permission ?? defaultPermission);
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
                onPermissionChange={(perm) => {
                  if (
                    isWildcardActive &&
                    perm !== wildcardPermission &&
                    onCoveredPermissionChange
                  ) {
                    onCoveredPermissionChange(tool.id, perm);
                  } else if (!isWildcardActive) {
                    onPermissionChange(tool.id, perm);
                  }
                }}
                disabled={disabled}
                orgPermission={orgStates?.[tool.id]}
                orgConditions={toolOrgConditions}
                covered={isWildcardActive}
              />
            );
          })}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
};
