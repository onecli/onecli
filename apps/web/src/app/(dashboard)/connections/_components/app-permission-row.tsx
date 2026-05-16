"use client";

import { CircleCheck, Hand, Ban } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { Badge } from "@onecli/ui/components/badge";
import type {
  AppTool,
  AppPermissionLevel,
} from "@onecli/api/apps/app-permissions";
import type { RuleCondition } from "@onecli/api/validations/policy-rule";
import { resolveToolPermission } from "./resolve-tool-permission";

interface AppPermissionRowProps {
  tool: AppTool;
  permission: AppPermissionLevel;
  conditions: RuleCondition[];
  onPermissionChange: (permission: AppPermissionLevel) => void;
  disabled?: boolean;
  orgPermission?: AppPermissionLevel;
  orgConditions?: RuleCondition[];
}

const options: {
  value: AppPermissionLevel;
  label: string;
  icon: typeof CircleCheck;
}[] = [
  { value: "allow", label: "Always allow", icon: CircleCheck },
  { value: "manual_approval", label: "Needs approval", icon: Hand },
  { value: "block", label: "Block", icon: Ban },
];

export const AppPermissionRow = ({
  tool,
  permission,
  conditions,
  onPermissionChange,
  disabled,
  orgPermission,
  orgConditions,
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
        !isFullyLocked && "hover:bg-muted",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p
            className={cn(
              "text-sm transition-colors truncate",
              isFullyLocked && "text-muted-foreground/60",
            )}
          >
            {tool.name}
          </p>
          {isFullyLocked && (
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
        </div>
        {firstCondition ? (
          <p className="text-[11px] text-muted-foreground/70 mt-0.5">
            when {firstCondition.target} {firstCondition.operator} &ldquo;
            {firstCondition.value}&rdquo;
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
        {options.map((opt) => {
          const isActive = effectivePermission === opt.value;
          const isBlockActive = isActive && opt.value === "block";
          const isApprovalActive = isActive && opt.value === "manual_approval";
          const optDisabled = resolved.isOptionDisabled(opt.value);
          return (
            <Tooltip key={opt.value}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onPermissionChange(opt.value)}
                  disabled={disabled || optDisabled}
                  className={cn(
                    "flex items-center justify-center size-8 rounded-md transition-colors",
                    isBlockActive
                      ? "bg-destructive/10 text-destructive"
                      : isApprovalActive
                        ? "bg-blue-500/10 text-blue-500"
                        : isActive
                          ? "bg-brand/10 text-brand"
                          : optDisabled
                            ? "text-muted-foreground/50"
                            : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50",
                    (disabled || optDisabled) &&
                      "opacity-50 cursor-not-allowed",
                  )}
                >
                  <opt.icon
                    className={cn("size-4", isActive && "stroke-[2.5]")}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {opt.label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
};
