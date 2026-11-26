"use client";

import { usePathname } from "next/navigation";
import { agentSectionPath } from "@/lib/navigation";
import type { RunsView } from "@/lib/agents/runs/runs-view";

/**
 * Where an agent's runs and requests are shown: the agent's own Activity
 * section, narrowed by query. One hook so
 * the kebab's "View activity", a schedule's "History" and a webhook's
 * "View runs" cannot drift apart.
 */
export const useAgentActivityPaths = () => {
  const pathname = usePathname();
  const own = (agentId: string, query: Record<string, string>) =>
    `${agentSectionPath(pathname, agentId, "activity")}?${new URLSearchParams(query).toString()}`;
  return {
    /** Everything the agent did: its runs and its requests. */
    activity: (agentId: string): string =>
      agentSectionPath(pathname, agentId, "activity"),
    /** The runs list on one of its filters. */
    runs: (agentId: string, view: RunsView): string => own(agentId, { view }),
    /** One schedule's runs. */
    scheduleRuns: (agentId: string, cronId: string): string =>
      own(agentId, { view: "cron", schedule: cronId }),
    /** One webhook's runs. */
    webhookRuns: (agentId: string, webhookId: string): string =>
      own(agentId, { view: "webhook", webhook: webhookId }),
  };
};
