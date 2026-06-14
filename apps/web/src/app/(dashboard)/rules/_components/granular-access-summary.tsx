"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { getApp } from "@onecli/api/apps/registry";
import { withProjectPrefix } from "@/lib/navigation";
import { AppIcon } from "@/app/(dashboard)/connections/_components/app-icon";
import { granularAccessConfigs } from "@/lib/granular-access";
import type { AgentGranularAccess } from "@/lib/api/types";

type ResolvedEntry = AgentGranularAccess & {
  summary: string;
  appName: string;
  icon?: string;
  darkIcon?: string;
};

interface GranularAccessSummaryProps {
  entries: AgentGranularAccess[];
}

export const GranularAccessSummary = ({
  entries,
}: GranularAccessSummaryProps) => {
  const pathname = usePathname();
  const agentsHref = withProjectPrefix(pathname, "/agents");

  // Resolve each entry's one-line summary via its provider config, dropping
  // entries that resolve to "all access" (no real restriction).
  const resolved: ResolvedEntry[] = entries.flatMap((e) => {
    const config = granularAccessConfigs.get(e.provider);
    if (!config) return [];
    const selected = config.getSelectedItems(e.policy);
    if (selected.length === 0) return [];
    const summary = config.formatSummary
      ? config.formatSummary(e.policy, {})
      : `${selected.length} ${
          selected.length === 1
            ? config.itemLabel.singular
            : config.itemLabel.plural
        }`;
    const app = getApp(e.provider);
    return [
      {
        ...e,
        summary,
        appName: app?.name ?? e.provider,
        icon: app?.icon,
        darkIcon: app?.darkIcon,
      },
    ];
  });

  if (resolved.length === 0) return null;

  const byAgent = new Map<string, ResolvedEntry[]>();
  for (const e of resolved) {
    const list = byAgent.get(e.agentId) ?? [];
    list.push(e);
    byAgent.set(e.agentId, list);
  }

  return (
    <div className="space-y-2">
      {[...byAgent.values()].map((list) => {
        const agentName = list[0]?.agentName ?? "Agent";
        const agentId = list[0]?.agentId ?? "";
        return (
          <div key={agentId} className="rounded-lg border p-4">
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {agentName}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground text-xs"
                asChild
              >
                <Link href={agentsHref}>Manage</Link>
              </Button>
            </div>
            <div className="mt-2 space-y-1.5 border-t pt-2">
              {list.map((e) => (
                <div key={e.connectionId} className="flex items-center gap-2.5">
                  {e.icon && (
                    <AppIcon
                      icon={e.icon}
                      darkIcon={e.darkIcon}
                      name={e.appName}
                      size={14}
                    />
                  )}
                  <span className="text-muted-foreground min-w-0 truncate text-xs">
                    {e.connectionLabel ?? e.appName}
                  </span>
                  <span className="text-muted-foreground/40 text-xs">·</span>
                  <Badge
                    variant="outline"
                    className="text-muted-foreground shrink-0 text-xs"
                  >
                    {e.summary}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};
