"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { channels } from "@/lib/api";
import type {
  ChannelProvider,
  ChannelReachState,
  ChannelTransport,
  CompletePresenceInput,
} from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// Channel mutations are headless (the use-app-config convention): the callers
// (the agent Channels section, the org settings cards) own the toasts. No
// `invalidateGatewayCache()` anywhere — deliberate: the gateway reads none of
// the channel tables (its approvals key is matched by raw string, not cached
// config), so a flush would be pure noise.

/** The one payload the agent's Channels section renders: presences + posture
 * + org-integration availability + adapter liveness. */
export const useAgentChannels = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.channels.agent(agentId),
    queryFn: () => channels.agentView(agentId),
    // This page's truth changes in ANOTHER tab (Slack's install/uninstall
    // pages) and the round-trip is often under the global 30s staleTime,
    // which would swallow the focus refetch. Always refetch on return.
    staleTime: 0,
  });

/** The paste floor's step 0 — fetched only while the floor is on screen.
 * Keyed by the chosen transport: the manifest bakes it in. */
export const useChannelManifest = (
  agentId: string,
  provider: ChannelProvider,
  enabled: boolean,
  transport?: ChannelTransport,
) =>
  useQuery({
    queryKey: queryKeys.channels.manifest(agentId, provider, transport),
    queryFn: () => channels.manifest(agentId, provider, transport),
    enabled,
  });

/** The guided arm: create the provider app from the org credential. Safe to
 * re-run on a pending presence — the server returns fresh URLs (resume). */
export const useAttachChannel = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { transport?: ChannelTransport } | undefined) =>
      channels.attach(agentId, provider, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
      // The agent lists carry the attached channels (the connected marks,
      // the delete confirmation) — root(), so the sweep reaches the
      // sidebar's for-workspace key too.
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
    },
  });
};

/** The pasted-tokens completion door (socket arm + the whole paste floor). */
export const useCompleteChannel = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CompletePresenceInput) =>
      channels.complete(agentId, provider, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
      // The agent lists carry the attached channels (the connected marks,
      // the delete confirmation) — root(), so the sweep reaches the
      // sidebar's for-workspace key too.
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
    },
  });
};

export const useDetachChannel = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (options: { deleteRemote: boolean }) =>
      channels.detach(agentId, provider, options),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
      // The agent lists carry the attached channels (the connected marks,
      // the delete confirmation) — root(), so the sweep reaches the
      // sidebar's for-workspace key too.
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
    },
  });
};

/** Settle one channel (channels view `spaces` rows): anyone in it, OneCLI
 * users only, or blocked entirely. */
export const useSetReachState = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      externalRef: string;
      state: Exclude<ChannelReachState, "pending">;
    }) =>
      channels.setReachState(agentId, provider, input.externalRef, input.state),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    },
  });
};

/** Settle one PERSON (channels view `people` rows): allowed, or not. */
export const useSetPersonReachState = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      externalRef: string;
      state: "approved" | "blocked";
    }) =>
      channels.setPersonReachState(
        agentId,
        provider,
        input.externalRef,
        input.state,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    },
  });
};

/** DISMISS a person row - forget the decision; they re-knock if they write. */
export const useDismissPersonReach = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { externalRef: string }) =>
      channels.dismissPersonReach(agentId, provider, input.externalRef),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    },
  });
};

/** DISMISS a channel row - forget it entirely; the next outside message
 * re-knocks and a re-mention re-links the threads. */
export const useDismissReachRow = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { externalRef: string }) =>
      channels.dismissReachRow(agentId, provider, input.externalRef),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    },
  });
};
