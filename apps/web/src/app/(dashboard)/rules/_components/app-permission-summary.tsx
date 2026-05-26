"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ban, ChevronDown, Hand, ShieldCheck } from "lucide-react";
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
import { withProjectPrefix } from "@/lib/navigation";
import { AppIcon } from "@/app/(dashboard)/connections/_components/app-icon";
import type { PolicyRuleItem } from "./types";

interface AppPermissionSummaryProps {
  rules: PolicyRuleItem[];
  pageScope: "project" | "organization";
  connectedProviders?: Map<string, string[]>;
}

interface ToolRule {
  name: string;
  action: string;
  isInherited: boolean;
  conditionLabel?: string;
}

interface AppGroup {
  provider: string;
  appName: string;
  icon: string;
  darkIcon?: string;
  tools: ToolRule[];
}

const extractToolName = (ruleName: string) =>
  ruleName.replace(/^[^:]+:\s*/, "");

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
                {group.tools.length}{" "}
                {group.tools.length === 1 ? "rule" : "rules"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {group.tools.map((t) => t.name).join(", ")}
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
              <div key={tool.name} className="flex items-start gap-2 py-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    {tool.action === "block" ? (
                      <Ban className="size-3 text-destructive shrink-0 mt-0.5" />
                    ) : tool.action === "allow" ? (
                      <ShieldCheck className="size-3 text-emerald-500 shrink-0 mt-0.5" />
                    ) : (
                      <Hand className="size-3 text-blue-500 shrink-0 mt-0.5" />
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    {tool.action === "block"
                      ? "Blocked"
                      : tool.action === "allow"
                        ? "Allowed"
                        : "Needs approval"}
                  </TooltipContent>
                </Tooltip>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      {tool.name}
                    </span>
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
              </div>
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
}: AppPermissionSummaryProps) => {
  const pathname = usePathname();

  const grouped = new Map<string, AppGroup>();
  for (const rule of rules) {
    const meta = rule.metadata as { provider?: string } | null;
    const provider = meta?.provider;
    if (!provider) continue;

    let group = grouped.get(provider);
    if (!group) {
      const app = getApp(provider);
      group = {
        provider,
        appName: app?.name ?? provider,
        icon: app?.icon ?? "",
        darkIcon: app?.darkIcon,
        tools: [],
      };
      grouped.set(provider, group);
    }

    const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
    const firstCond = conditions[0] as
      | { target?: string; operator?: string; value?: string }
      | undefined;
    group.tools.push({
      name: extractToolName(rule.name),
      action: rule.action,
      isInherited: rule.scope != null && rule.scope !== pageScope,
      conditionLabel: firstCond?.value
        ? `when ${firstCond.target} ${firstCond.operator} "${firstCond.value}"`
        : undefined,
    });
  }

  const sortedGroups = [...grouped.values()].sort((a, b) => {
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
            ? `/global-connections/apps/${group.provider}`
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
