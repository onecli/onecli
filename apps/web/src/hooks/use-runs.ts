"use client";

import { useQuery } from "@tanstack/react-query";
import { runs } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { isActiveTurnStatus } from "@/lib/chat/turns";

/** How often a run still in progress is refreshed while open. */
const ACTIVE_RUN_POLL_MS = 5_000;

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
