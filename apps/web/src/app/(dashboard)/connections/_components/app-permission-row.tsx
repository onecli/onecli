"use client";

import { cn } from "@onecli/ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { Badge } from "@onecli/ui/components/badge";
import type {
  AppToolSummary,
  AppPermissionLevel,
} from "@onecli/api/apps/app-permissions";
import type { RuleCondition } from "@onecli/api/validations/policy-rule";
import { resolveToolPermission } from "./resolve-tool-permission";
import { PermissionButtons } from "./permission-buttons";

interface AppPermissionRowProps {
  tool: AppToolSummary;
  permission: AppPermissionLevel;
  conditions: RuleCondition[];
  onPermissionChange: (permission: AppPermissionLevel) => void;
  disabled?: boolean;
  orgPermission?: AppPermissionLevel;
  orgConditions?: RuleCondition[];
  covered?: boolean;
  /** Agent view: value comes from the all-agents layer (no override yet). */
  inherited?: boolean;
  inheritedLabel?: string;
  /** Agent view: this agent has an explicit override for the tool. */
  overridden?: boolean;
  onRevert?: () => void;
}

export const AppPermissionRow = ({
  tool,
  permission,
  conditions,
  onPermissionChange,
  disabled,
  orgPermission,
  orgConditions,
  covered,
  inherited,
  inheritedLabel,
  overridden,
  onRevert,
}: AppPermissionRowProps) => {
  const resolved = resolveToolPermission(
    permission,
    conditions,
    orgPermission,
    orgConditions,
  );

  const { effectivePermission, displayConditions, isFullyLocked, orgLine } =
    resolved;
  const firstCondition = displayConditions[0];

  return (
    <div
      className={cn(
        "flex items-center gap-3 py-2.5 border-b border-border/50 last:border-b-0 -mx-3 px-3 rounded-lg transition-colors",
        !isFullyLocked && !covered && "hover:bg-muted",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p
            className={cn(
              "text-sm transition-colors truncate",
              (isFullyLocked || covered || inherited) &&
                "text-muted-foreground/60",
            )}
          >
            {tool.name}
          </p>
          {isFullyLocked && !covered && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  Organization
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                Enforced by organization policy
              </TooltipContent>
            </Tooltip>
          )}
          {overridden && !isFullyLocked && (
            <span className="text-[10px] font-medium text-brand shrink-0">
              Overridden
            </span>
          )}
        </div>
        {firstCondition ? (
          <p className="text-[11px] text-muted-foreground/70 mt-0.5">
            when {firstCondition.target} {firstCondition.operator} &ldquo;
            {firstCondition.value}&rdquo;
          </p>
        ) : null}
        {inherited && !isFullyLocked && inheritedLabel ? (
          <p className="text-[11px] text-muted-foreground/70 mt-0.5">
            {inheritedLabel}
          </p>
        ) : null}
        {orgLine ? (
          <p className="text-[10px] text-muted-foreground/50 mt-0.5">
            {orgLine}
          </p>
        ) : null}
      </div>
      <div
        className={cn(
          "flex items-center gap-1 shrink-0",
          isFullyLocked && "opacity-50",
        )}
      >
        {overridden && !isFullyLocked && onRevert && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onRevert}
                  disabled={disabled}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 px-1.5"
                >
                  Reset
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                Return to inherited setting
              </TooltipContent>
            </Tooltip>
            <div className="w-px h-4 bg-border mx-0.5" />
          </>
        )}
        <PermissionButtons
          activePermission={effectivePermission}
          onSelect={onPermissionChange}
          isOptionDisabled={resolved.isOptionDisabled}
          covered={covered || inherited}
          disabled={disabled}
        />
      </div>
    </div>
  );
};
