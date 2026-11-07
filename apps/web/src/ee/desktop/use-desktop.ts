"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as desktop from "./api";
import type { DesktopState } from "./api";
import { queryKeys } from "@/lib/api/keys";
import { LIVE_POLL_MS } from "@/hooks/use-live-list";

/**
 * The Computer section's one read. Polling cadence follows the state: while the box is asleep or waking the page
 * waits for a screen (the Ports cadence, {@link LIVE_POLL_MS}); while it
 * is awake the poll carries only the controller and the agent's ask,
 * which change on human timescales, so it slows to a few seconds more.
 * Visible tab only; `staleTime: 0` so a tab switch back refetches at once.
 * A failed poll keeps the last good answer on screen (`isLoadingError`).
 *
 * `poll` is for surfaces that need less: `idle` (the agent header's
 * Computer button off Chat, which only has to notice an ask) checks every
 * {@link IDLE_POLL_MS}; `off` reads the shared cache while another observer
 * on the page (the chat's dock) already polls it.
 */
export const useDesktop = (
  agentId: string,
  { poll = "live" }: { poll?: "live" | "idle" | "off" } = {},
) => {
  const query = useQuery({
    queryKey: queryKeys.desktop.agent(agentId),
    queryFn: () => desktop.get(agentId),
    refetchInterval: (q) =>
      poll === "off"
        ? false
        : poll === "idle"
          ? IDLE_POLL_MS
          : q.state.data?.sandboxState === "awake"
            ? AWAKE_POLL_MS
            : LIVE_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
  return {
    data: query.data,
    isPending: query.isPending,
    isError: query.isLoadingError,
    refetch: query.refetch,
  };
};

/** The awake poll: the controller and the ask change on human timescales. */
export const AWAKE_POLL_MS = 5_000;

/** The idle poll: a glance for an ask from beside another section. */
export const IDLE_POLL_MS = 15_000;

const useRefreshDesktop = (agentId: string) => {
  const qc = useQueryClient();
  return () =>
    qc.invalidateQueries({ queryKey: queryKeys.desktop.agent(agentId) });
};

/**
 * Wake and take-control share one shape: the server's answer IS the new
 * state, written straight into the cache so the section moves on the same
 * tick rather than one poll later (`waking` after a wake; the control host
 * after a take). A refusal invalidates instead, so the view catches up with
 * whatever the server now says (someone else took the lease, the box went
 * to sleep).
 */
const useStateMutation = (
  agentId: string,
  mutationFn: () => Promise<DesktopState>,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (state: DesktopState) => {
      qc.setQueryData(queryKeys.desktop.agent(agentId), state);
    },
    onError: () =>
      qc.invalidateQueries({ queryKey: queryKeys.desktop.agent(agentId) }),
  });
};

/** Start the sandbox. */
export const useWakeDesktop = (agentId: string) =>
  useStateMutation(agentId, () => desktop.wake(agentId));

/** Take the lease. 409 when someone else holds it. */
export const useTakeControl = (agentId: string) =>
  useStateMutation(agentId, () => desktop.takeControl(agentId));

/** Hand the desktop back (Stop). */
export const useReleaseControl = (agentId: string) => {
  const refresh = useRefreshDesktop(agentId);
  return useMutation({
    mutationFn: () => desktop.releaseControl(agentId),
    onSettled: refresh,
  });
};
