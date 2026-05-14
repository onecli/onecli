"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ban, ChevronDown, Hand } from "lucide-react";
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
}

interface ToolRule {
  name: string;
  action: string;
  isInherited: boolean;
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
}: {
  group: AppGroup;
  href: string;
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
              <Button variant="ghost" size="icon" className="size-8">
                <ChevronDown
                  className={cn(
                    "size-4 text-muted-foreground transition-transform duration-200",
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
              <div key={tool.name} className="flex items-center gap-2 py-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    {tool.action === "block" ? (
                      <Ban className="size-3 text-destructive shrink-0" />
                    ) : (
                      <Hand className="size-3 text-blue-500 shrink-0" />
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    {tool.action === "block" ? "Blocked" : "Needs approval"}
                  </TooltipContent>
                </Tooltip>
                <span className="text-xs text-muted-foreground">
                  {tool.name}
                </span>
                {tool.isInherited && (
                  <span className="text-[11px] text-muted-foreground/50">
                    · Organization
                  </span>
                )}
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

    group.tools.push({
      name: extractToolName(rule.name),
      action: rule.action,
      isInherited: rule.scope != null && rule.scope !== pageScope,
    });
  }

  const sortedGroups = [...grouped.values()].sort((a, b) =>
    a.appName.localeCompare(b.appName),
  );

  return (
    <div className="space-y-2">
      {sortedGroups.map((group) => {
        const href = withProjectPrefix(
          pathname,
          `/connections/apps/${group.provider}`,
        );

        return (
          <AppPermissionCard key={group.provider} group={group} href={href} />
        );
      })}
    </div>
  );
};
