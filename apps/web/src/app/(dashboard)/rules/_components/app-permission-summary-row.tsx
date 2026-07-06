"use client";

import { Ban, Hand, ShieldCheck } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@onecli/ui/components/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { cn } from "@onecli/ui/lib/utils";
import type { AppPermissionLevel } from "@onecli/api/apps/app-permissions";

export interface ToolException {
  agentId: string;
  agentName: string;
  permission: AppPermissionLevel;
  conditionLabel?: string;
}

/** One tool's effective summary: the default-layer state + agent exceptions. */
export interface ToolSummary {
  key: string;
  name: string;
  permission: AppPermissionLevel;
  /** No default-layer rule exists — `permission` is the mode default. */
  implicit: boolean;
  isInherited: boolean;
  conditionLabel?: string;
  exceptions: ToolException[];
}

const PERMISSION_META: Record<
  AppPermissionLevel,
  { label: string; Icon: typeof Ban; className: string }
> = {
  allow: { label: "Allowed", Icon: ShieldCheck, className: "text-emerald-500" },
  manual_approval: {
    label: "Needs approval",
    Icon: Hand,
    className: "text-blue-500",
  },
  block: { label: "Blocked", Icon: Ban, className: "text-destructive" },
};

const PERMISSION_ORDER: AppPermissionLevel[] = [
  "allow",
  "manual_approval",
  "block",
];

const PermissionIcon = ({
  permission,
  className,
}: {
  permission: AppPermissionLevel;
  className?: string;
}) => {
  const { Icon } = PERMISSION_META[permission];
  return (
    <Icon
      className={cn(
        "size-3 shrink-0",
        PERMISSION_META[permission].className,
        className,
      )}
    />
  );
};

// Exception-cluster display tiers: all inline; truncated + "+N"; value-grouped
// counts once names stop being scannable.
const INLINE_LIMIT = 3;
const TRUNCATED_SHOWN = 2;
const GROUPED_THRESHOLD = 8;

export const AppPermissionSummaryRow = ({ tool }: { tool: ToolSummary }) => {
  const { exceptions } = tool;
  const meta = PERMISSION_META[tool.permission];

  const inline =
    exceptions.length <= INLINE_LIMIT
      ? exceptions
      : exceptions.length < GROUPED_THRESHOLD
        ? exceptions.slice(0, TRUNCATED_SHOWN)
        : [];
  const hiddenCount = exceptions.length - inline.length;

  const valueGroups = PERMISSION_ORDER.map((permission) => ({
    permission,
    agents: exceptions.filter((e) => e.permission === permission),
  })).filter((group) => group.agents.length > 0);

  return (
    <div className="flex items-start gap-2 py-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="mt-0.5 shrink-0">
            <PermissionIcon
              permission={tool.permission}
              className={cn(tool.implicit && "text-muted-foreground/40")}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-xs">
          {tool.implicit ? `${meta.label} by default` : meta.label}
        </TooltipContent>
      </Tooltip>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{tool.name}</span>
          {tool.isInherited && (
            <span className="text-[11px] text-muted-foreground/50">
              · Organization
            </span>
          )}
        </div>
        {tool.conditionLabel && (
          <p className="text-[10px] text-muted-foreground/50 truncate">
            {tool.conditionLabel}
          </p>
        )}
      </div>
      {exceptions.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 -my-0.5 transition-colors hover:bg-muted"
              aria-label={`except: ${exceptions.length} agent ${
                exceptions.length === 1 ? "override" : "overrides"
              } for ${tool.name}`}
            >
              <span className="text-[11px] text-muted-foreground/60">
                except
              </span>
              <span className="hidden items-center gap-1.5 sm:flex">
                {inline.map((exception) => (
                  <span
                    key={exception.agentId}
                    className="flex items-center gap-1"
                  >
                    <PermissionIcon permission={exception.permission} />
                    <span className="text-[11px] text-muted-foreground">
                      {exception.agentName}
                    </span>
                  </span>
                ))}
                {exceptions.length >= GROUPED_THRESHOLD &&
                  valueGroups.map((group) => (
                    <span
                      key={group.permission}
                      className="flex items-center gap-1"
                    >
                      <PermissionIcon permission={group.permission} />
                      <span className="text-[11px] text-muted-foreground">
                        {group.agents.length}
                      </span>
                    </span>
                  ))}
                {hiddenCount > 0 && exceptions.length < GROUPED_THRESHOLD && (
                  <span className="rounded-full border px-1.5 text-[11px] text-muted-foreground">
                    +{hiddenCount}
                  </span>
                )}
              </span>
              <span className="rounded-full border px-1.5 text-[11px] text-muted-foreground sm:hidden">
                {exceptions.length}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-3">
            <div className="space-y-2.5">
              {valueGroups.map((group) => (
                <div key={group.permission}>
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <PermissionIcon permission={group.permission} />
                    {PERMISSION_META[group.permission].label}
                  </div>
                  <div className="mt-0.5 space-y-0.5 pl-[18px]">
                    {group.agents.map((exception) => (
                      <div key={exception.agentId}>
                        <p className="text-xs">{exception.agentName}</p>
                        {exception.conditionLabel && (
                          <p className="text-[10px] text-muted-foreground/60">
                            {exception.conditionLabel}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
};
