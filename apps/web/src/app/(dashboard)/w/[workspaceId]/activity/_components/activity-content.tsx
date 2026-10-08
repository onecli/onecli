"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  AnimatedTabs,
  AnimatedTabList,
  AnimatedTabTrigger,
} from "@onecli/ui/components/animated-tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { activityScopeSchema } from "@onecli/api/validations/request-logs";
import { RUN_WINDOW_SLACK_MS } from "@onecli/api/validations/runs";
import { PageHeader } from "@dashboard/page-header";
import { useAgents } from "@/hooks/use-agents";
import type { RunListItem } from "@/lib/api";
import { RunsTab } from "./runs-tab";
import { NetworkTab } from "./network-tab";

const ALL_AGENTS = "all";

/** The Activity URL: `?tab=runs`, `?agent=<id>`, `?from=…&to=…`. */
interface ActivityUrl {
  tab?: "runs";
  agent?: string;
  from?: string;
  to?: string;
}

/** A run's [start, finish] window, padded like the server pads its evidence
 *  scan, as the Network tab's time window. An unfinished run is open-ended. */
const runWindow = (run: RunListItem) => {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  return {
    from: new Date(start - RUN_WINDOW_SLACK_MS).toISOString(),
    ...(run.finishedAt && {
      to: new Date(
        Date.parse(run.finishedAt) + RUN_WINDOW_SLACK_MS,
      ).toISOString(),
    }),
  };
};

/**
 * Activity: what happened in this workspace, two ways.
 *  - Network (default): every request through the gateway.
 *  - Runs: each question an agent answered.
 * The tab, the agent and a run's time window live in the URL, so an agent's
 * "View activity" and a run's "View requests in Network" land on the right
 * view, and refresh keeps it. Updates go through the History API: only this
 * component reads them, so no server round-trip is needed (Next keeps
 * `useSearchParams` in sync).
 */
export const ActivityContent = () => {
  const pathname = usePathname();
  const params = useSearchParams();
  const { data: agents = [] } = useAgents();

  const tab = params.get("tab") === "runs" ? "runs" : "network";
  // A hand-edited or stale URL must not reach the query: an invalid scope is
  // dropped whole.
  const parsed = activityScopeSchema.safeParse({
    agentId: params.get("agent") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
  });
  const scope = parsed.success ? parsed.data : {};

  const go = (next: ActivityUrl, history: "push" | "replace" = "replace") => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) {
      if (value) q.set(key, value);
    }
    const qs = q.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    if (history === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  };

  // Switching tab or agent keeps the other and drops a run's window: the
  // window only means something on the Network view it was opened for.
  const onTab = (value: string) =>
    go({ tab: value === "runs" ? "runs" : undefined, agent: scope.agentId });
  const onAgent = (id: string) =>
    go({
      tab: tab === "runs" ? "runs" : undefined,
      agent: id === ALL_AGENTS ? undefined : id,
    });
  // A new history entry: Back returns to the run list.
  const viewRunNetwork = (run: RunListItem) =>
    go({ agent: run.agent.id, ...runWindow(run) }, "push");

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6">
      <PageHeader
        title="Activity"
        description="What your agents did, and every request through your gateway. Request bodies and query strings are never recorded."
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <AnimatedTabs value={tab} onValueChange={onTab}>
          <AnimatedTabList>
            <AnimatedTabTrigger value="network">Network</AnimatedTabTrigger>
            <AnimatedTabTrigger value="runs">Runs</AnimatedTabTrigger>
          </AnimatedTabList>
        </AnimatedTabs>
        <Select value={scope.agentId ?? ALL_AGENTS} onValueChange={onAgent}>
          <SelectTrigger className="h-8 w-48 text-xs" aria-label="Agent">
            <SelectValue placeholder="All agents" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_AGENTS}>All agents</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {tab === "runs" ? (
        <RunsTab agentId={scope.agentId} onViewNetwork={viewRunNetwork} />
      ) : (
        <NetworkTab
          scope={scope}
          onClearWindow={() => go({ agent: scope.agentId })}
        />
      )}
    </div>
  );
};
