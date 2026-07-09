"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@onecli/ui/components/collapsible";
import { cn } from "@onecli/ui/lib/utils";
import { getApp } from "@onecli/api/apps/registry";
import { mapRuleActionToPermission } from "@onecli/api/apps/app-permissions/types";
import type { AppPermissionLevel } from "@onecli/api/apps/app-permissions";
import { useAppPermissionDefinitions } from "@/hooks/use-app-permissions";
import type { PolicyMode } from "@onecli/api/validations/policy-rule";
import { withProjectPrefix, withOrgPrefix } from "@/lib/navigation";
import { AppIcon } from "@/app/(dashboard)/connections/_components/app-icon";
import type { AgentOption, PolicyRuleItem } from "./types";
import {
  AppPermissionSummaryRow,
  type ToolException,
  type ToolSummary,
} from "./app-permission-summary-row";

interface AppPermissionSummaryProps {
  rules: PolicyRuleItem[];
  pageScope: "project" | "organization";
  connectedProviders?: Map<string, string[]>;
  agents?: AgentOption[];
  policyMode?: PolicyMode;
}

interface AppGroup {
  provider: string;
  appName: string;
  icon: string;
  darkIcon?: string;
  tools: ToolSummary[];
}

/** Display-side mirror of the gateway's action priority (strictest wins). */
const DISPLAY_STRICTNESS: Record<AppPermissionLevel, number> = {
  allow: 0,
  manual_approval: 1,
  block: 2,
};

interface MutableTool {
  name: string;
  defaultPermission?: AppPermissionLevel;
  isInherited: boolean;
  conditionLabel?: string;
  exceptions: Map<string, ToolException>;
}

const extractToolName = (ruleName: string) =>
  ruleName.replace(/^[^:]+:\s*/, "");

const conditionLabelOf = (rule: PolicyRuleItem): string | undefined => {
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  const first = conditions[0] as
    | { target?: string; operator?: string; value?: string }
    | undefined;
  return first?.value
    ? `when ${first.target} ${first.operator} "${first.value}"`
    : undefined;
};

const AppPermissionCard = ({
  group,
  href,
  connectionLabels,
}: {
  group: AppGroup;
  href: string;
  connectionLabels: string[];
}) => {
  const [open, setOpen] = useState(false);
  const rulesCount = group.tools.filter((t) => !t.implicit).length;
  const overridesCount = group.tools.reduce(
    (n, t) => n + t.exceptions.length,
    0,
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border p-4">
        <div className="flex items-center gap-3">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted">
            {group.icon && (
              <AppIcon
                icon={group.icon}
                darkIcon={group.darkIcon}
                name={group.appName}
                size={16}
              />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{group.appName}</span>
              {connectionLabels.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="bg-brand size-2 shrink-0 rounded-full" />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {connectionLabels.length === 1 && connectionLabels[0]
                      ? connectionLabels[0]
                      : connectionLabels.length > 1
                        ? `${connectionLabels.length} accounts connected`
                        : "Connected"}
                  </TooltipContent>
                </Tooltip>
              )}
              <Badge
                variant="outline"
                className="text-xs text-muted-foreground"
              >
                {rulesCount} {rulesCount === 1 ? "rule" : "rules"}
                {overridesCount > 0 &&
                  ` · ${overridesCount} ${
                    overridesCount === 1 ? "override" : "overrides"
                  }`}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {[...new Set(group.tools.map((t) => t.name))].join(", ")}
            </p>
          </div>
          <div className="flex items-center gap-1 ml-auto shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
              asChild
            >
              <Link href={href}>Manage</Link>
            </Button>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="icon" className="size-9">
                <ChevronDown
                  className={cn(
                    "size-5 text-muted-foreground transition-transform duration-200",
                    open && "rotate-180",
                  )}
                />
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <div className="ml-10 mt-2 space-y-0.5 border-t pt-2">
            {group.tools.map((tool) => (
              <AppPermissionSummaryRow key={tool.key} tool={tool} />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};

export const AppPermissionSummary = ({
  rules,
  pageScope,
  connectedProviders,
  agents,
  policyMode = "allow",
}: AppPermissionSummaryProps) => {
  const pathname = usePathname();
  const agentNames = new Map((agents ?? []).map((a) => [a.id, a.name]));
  const implicitDefault: AppPermissionLevel =
    policyMode === "deny" ? "block" : "allow";
  // While the catalog query is pending, wildcard covering-defaults are briefly
  // unresolved — rows fall back to the mode default and converge on load.
  const { data: permissionDefinitions } = useAppPermissionDefinitions();
  const definitionByProvider = new Map(
    (permissionDefinitions ?? []).map((def) => [def.provider, def]),
  );

  // Group rule rows by provider, then fold them into one summary per tool:
  // the default-layer state plus one exception per overriding agent
  // (strictest across a tool's endpoint-variant rows).
  const byProvider = new Map<string, Map<string, MutableTool>>();
  for (const rule of rules) {
    if (!rule.enabled) continue; // disabled rows are not effective policy
    const meta = rule.metadata as {
      provider?: string;
      toolId?: string;
      type?: string;
      hostId?: string;
    } | null;
    const provider = meta?.provider;
    if (!provider) continue;

    const tools = byProvider.get(provider) ?? new Map<string, MutableTool>();
    byProvider.set(provider, tools);

    const key =
      meta?.toolId ??
      (meta?.type === "blocklist"
        ? `blocklist:${meta.hostId ?? rule.id}`
        : rule.id);
    const tool = tools.get(key) ?? {
      name: extractToolName(rule.name),
      isInherited: false,
      exceptions: new Map<string, ToolException>(),
    };
    tools.set(key, tool);

    const permission = mapRuleActionToPermission(rule.action);
    const conditionLabel = conditionLabelOf(rule);

    if (rule.agentId) {
      const existing = tool.exceptions.get(rule.agentId);
      if (
        !existing ||
        DISPLAY_STRICTNESS[permission] > DISPLAY_STRICTNESS[existing.permission]
      ) {
        tool.exceptions.set(rule.agentId, {
          agentId: rule.agentId,
          agentName: agentNames.get(rule.agentId) ?? "Agent",
          permission,
          conditionLabel: conditionLabel ?? existing?.conditionLabel,
        });
      } else if (conditionLabel && !existing.conditionLabel) {
        existing.conditionLabel = conditionLabel;
      }
    } else {
      // Inheritance/condition markers belong to the row that wins the
      // strictness fold, not to whichever row happened to come first.
      const inherited = rule.scope != null && rule.scope !== pageScope;
      if (
        tool.defaultPermission === undefined ||
        DISPLAY_STRICTNESS[permission] >
          DISPLAY_STRICTNESS[tool.defaultPermission]
      ) {
        tool.defaultPermission = permission;
        tool.isInherited = inherited;
        tool.conditionLabel = conditionLabel;
      } else if (
        DISPLAY_STRICTNESS[permission] ===
        DISPLAY_STRICTNESS[tool.defaultPermission]
      ) {
        tool.isInherited ||= inherited;
        tool.conditionLabel ??= conditionLabel;
      }
    }
  }

  const groups: AppGroup[] = [...byProvider].map(([provider, tools]) => {
    const app = getApp(provider);

    // A tool without its own default rows may still be covered by its group's
    // wildcard row (e.g. an org-level "All read operations" block) — the
    // effective default then comes from that wildcard, not the mode default.
    const wildcardIdByToolId = new Map<string, string>();
    for (const group of definitionByProvider.get(provider)?.groups ?? []) {
      if (!group.wildcard) continue;
      for (const groupTool of group.tools) {
        wildcardIdByToolId.set(groupTool.id, group.wildcard.id);
      }
    }
    const coveringDefault = (key: string): AppPermissionLevel | undefined => {
      const wildcardId = wildcardIdByToolId.get(key);
      return wildcardId ? tools.get(wildcardId)?.defaultPermission : undefined;
    };

    return {
      provider,
      appName: app?.name ?? provider,
      icon: app?.icon ?? "",
      darkIcon: app?.darkIcon,
      tools: [...tools]
        .map(
          ([key, tool]): ToolSummary => ({
            key,
            name: tool.name,
            permission:
              tool.defaultPermission ?? coveringDefault(key) ?? implicitDefault,
            implicit: tool.defaultPermission === undefined,
            isInherited: tool.isInherited,
            conditionLabel: tool.conditionLabel,
            exceptions: [...tool.exceptions.values()].sort((a, b) =>
              a.agentName.localeCompare(b.agentName),
            ),
          }),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  const sortedGroups = groups.sort((a, b) => {
    const aConnected = connectedProviders?.has(a.provider) ?? false;
    const bConnected = connectedProviders?.has(b.provider) ?? false;
    if (aConnected !== bConnected) return aConnected ? -1 : 1;
    return a.appName.localeCompare(b.appName);
  });

  const getLabels = (provider: string) =>
    connectedProviders?.get(provider) ?? [];

  return (
    <div className="space-y-2">
      {sortedGroups.map((group) => {
        const href =
          pageScope === "organization"
            ? withOrgPrefix(
                pathname,
                `/global-connections/apps/${group.provider}`,
              )
            : withProjectPrefix(
                pathname,
                `/connections/apps/${group.provider}`,
              );

        return (
          <AppPermissionCard
            key={group.provider}
            group={group}
            href={href}
            connectionLabels={getLabels(group.provider)}
          />
        );
      })}
    </div>
  );
};
