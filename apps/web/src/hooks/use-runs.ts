"use client";

import { useCallback } from "react";
import {
  infiniteQueryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { runs } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type { RunsFilter } from "@/lib/api/runs";
import { isActiveTurnStatus } from "@/lib/chat/turns";
import { useLiveList } from "./use-live-list";

/** How often a run still in progress is refreshed while open. */
const ACTIVE_RUN_POLL_MS = 5_000;

/** Runs, newest first (one agent's, or the workspace's), as a Live list. */
export const useRunsList = (filter: Omit<RunsFilter, "before">) =>
  useLiveList(
    infiniteQueryOptions({
      queryKey: queryKeys.runs.list(filter),
      queryFn: ({ pageParam }) =>
        runs.list({ ...filter, ...(pageParam && { before: pageParam }) }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextBefore ?? undefined,
    }),
  );

/** One run in full, for the run detail panel. Polls while it is active. */
export const useRun = (agentId: string, turnId: string | null) =>
  useQuery({
    queryKey: queryKeys.runs.detail(agentId, turnId ?? "none"),
    queryFn: () => {
      if (turnId === null) throw new Error("A turn ID is required");
      return runs.get(agentId, turnId);
    },
    enabled: turnId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status && isActiveTurnStatus(status) ? ACTIVE_RUN_POLL_MS : false;
    },
  });

/**
 * A schedule's newest run id (still going or done), fetched when ASKED: the
 * schedules list carries no turn ids, and a run started since the last read
 * must be the one found, so this always asks the server.
 */
export const useNewestScheduleRun = (agentId: string, cronId: string) => {
  const qc = useQueryClient();
  return useCallback(async (): Promise<string | null> => {
    const page = await qc.fetchQuery({
      queryKey: queryKeys.runs.newest(agentId, cronId),
      queryFn: () => runs.list({ agentId, cronId }),
      staleTime: 0,
    });
    return page.runs[0]?.turnId ?? null;
  }, [qc, agentId, cronId]);
};
