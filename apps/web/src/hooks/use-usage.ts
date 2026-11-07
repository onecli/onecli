"use client";

import { useQuery } from "@tanstack/react-query";
import { usage } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type { UsageWindowQuery } from "@/lib/api/usage";

/** How often a running agent's awake time is refreshed while shown. */
const RUNNING_POLL_MS = 60_000;

/** One agent's awake time over a window (default: all time). Polls once a
 * minute while the agent is up, since the number is still growing. */
export const useAgentRuntimeUsage = (
  agentId: string,
  window: UsageWindowQuery = {},
) =>
  useQuery({
    queryKey: queryKeys.usage.agent(agentId, window),
    queryFn: () => usage.agent(agentId, window),
    refetchInterval: (query) =>
      query.state.data?.running ? RUNNING_POLL_MS : false,
  });

/** The org's awake time per agent over a window (default: all time). */
export const useOrgRuntimeUsage = (window: UsageWindowQuery = {}) =>
  useQuery({
    queryKey: queryKeys.usage.org(window),
    queryFn: () => usage.org(window),
  });
