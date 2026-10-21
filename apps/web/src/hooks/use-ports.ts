"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ports } from "@/lib/api";
import type { SandboxPortsResponse } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { patchItem, serializeWrite, wholeValue } from "@/lib/api/optimistic";
import {
  useFamilyWriting,
  useOptimisticMutation,
} from "@/hooks/use-optimistic-mutation";
import { LIVE_POLL_MS } from "./use-live-list";

// Port mutations are headless (the use-crons convention): the Ports section
// owns the toasts. No `invalidateGatewayCache()`: the gateway reads no
// sandbox_ports row.

/**
 * Live, on the Activity tabs' cadence ({@link LIVE_POLL_MS}): a port appears
 * on the page within one supervisor scan (5 s) plus one poll, so a person
 * watching the page sees the agent's new service without reloading.
 *
 * Polls only while the tab is visible (a background tab keeps the last
 * answer and catches up on focus); `staleTime: 0` so a tab switch back
 * refetches at once instead of trusting the provider's 30 s default. A
 * failed poll keeps the last good answer on screen (`isError` below is
 * `isLoadingError`: only the FIRST load failing is an error state). The
 * poll pauses while a ports write is in flight, so it can't repaint the
 * share a stop just took down.
 */
export const usePorts = (agentId: string) => {
  const writing = useFamilyWriting(portsFamily(agentId));
  const query = useQuery({
    queryKey: queryKeys.ports.agent(agentId),
    queryFn: () => ports.list(agentId),
    refetchInterval: writing ? false : LIVE_POLL_MS,
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

const portsFamily = (agentId: string) => `ports:${agentId}`;

/** One port's write queue, and the id its toasts share: a failed stop
 * replaces its own Undo toast instead of standing beside it. */
export const portToastId = (agentId: string, port: number) =>
  `port:${agentId}:${port}`;

/** Share a port. A plain request (the server mints the URL the row shows),
 * but queued per port behind any stop still in flight, so an Undo pressed
 * before the stop lands re-shares after it, never before. */
export const useSharePort = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (port: number) =>
      serializeWrite(portToastId(agentId, port), () =>
        ports.share(agentId, port),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.ports.agent(agentId) });
    },
  });
};

/**
 * Stop sharing a port, instantly: the share leaves the row on click (the
 * link going dark is the safe direction), and a failure brings it back.
 * Sharing stays a plain request: the server mints the URL it shows.
 */
export const useUnsharePort = (agentId: string) =>
  useOptimisticMutation<void, number>({
    family: portsFamily(agentId),
    itemKey: (port) => portToastId(agentId, port),
    write: (port) => ports.unshare(agentId, port),
    apply: (qc, port) =>
      patchItem(
        qc,
        queryKeys.ports.agent(agentId),
        wholeValue<SandboxPortsResponse>(),
        (view) =>
          view && {
            ...view,
            shares: view.shares.map((s) =>
              s.port === port && s.active ? { ...s, active: false } : s,
            ),
          },
      ),
    refresh: (qc) =>
      qc.invalidateQueries({ queryKey: queryKeys.ports.agent(agentId) }),
    failure: (_qc, port) => `Couldn't stop sharing port ${port}`,
  });

/** The preview login handoff: mints a one-minute ticket URL. A mutation (it
 * issues a credential server-side), never cached. */
export const usePreviewTicket = () =>
  useMutation({
    mutationFn: ({ host, path }: { host: string; path: string }) =>
      ports.previewTicket(host, path),
  });
