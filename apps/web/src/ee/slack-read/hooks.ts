"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/keys";
import * as api from "./api";
import type { GrantPatch, ReadGrant } from "./api";

const k = (agentId: string) => queryKeys.channels.slackRead(agentId);

/** The caller's own Slack connection to this agent. */
export const useSlackReadConnection = (agentId: string) =>
  useQuery({
    queryKey: [...k(agentId), "connection"],
    queryFn: () => api.getConnection(agentId),
  });

/** Every read grant on this agent (whoever made it). */
export const useSlackReadGrants = (agentId: string) =>
  useQuery({
    queryKey: [...k(agentId), "grants"],
    queryFn: () => api.listGrants(agentId),
  });

/** The caller's own conversations, for the picker. Fetched while open. */
export const useMyConversations = (agentId: string, enabled: boolean) =>
  useQuery({
    queryKey: [...k(agentId), "mine"],
    queryFn: () => api.listMyConversations(agentId),
    enabled,
    staleTime: 60_000,
  });

/** Start the consent flow; resolves to Slack's authorize URL. */
export const useStartSlackConnect = (agentId: string) =>
  useMutation({ mutationFn: () => api.startConnect(agentId) });

export const useDisconnectSlack = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.disconnect(agentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: k(agentId) }),
  });
};

export const useSetReadGrant = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      externalRef,
      ...patch
    }: { externalRef: string } & GrantPatch) =>
      api.setGrant(agentId, externalRef, patch),
    // Optimistic: the control moves on click; a failure puts it back.
    onMutate: async ({ externalRef, ...patch }) => {
      const key = [...k(agentId), "grants"];
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<{ grants: ReadGrant[] }>(key);
      if (previous) {
        qc.setQueryData<{ grants: ReadGrant[] }>(key, {
          // Only the caller's own share of it: someone else's share of the
          // same conversation is theirs, and this PUT never touches it.
          grants: previous.grants.map((g) =>
            g.mine && g.externalRef === externalRef ? { ...g, ...patch } : g,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData([...k(agentId), "grants"], context.previous);
      }
    },
    onSettled: () =>
      qc.invalidateQueries({ queryKey: [...k(agentId), "grants"] }),
  });
};

/** Share several of the caller's own conversations in one request. */
export const useShareConversations = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { externalRefs: string[] }) =>
      api.shareMany(agentId, input.externalRefs),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: [...k(agentId), "grants"] }),
  });
};

export const useDeleteReadGrant = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) => api.deleteGrant(agentId, grantId),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: [...k(agentId), "grants"] }),
  });
};

/** The workspace finder: which agents can read my Slack. Fetched on demand. */
export const useSlackReadAgents = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.channels.slackReadAgents(),
    queryFn: () => api.listSlackReadAgents(),
    enabled,
  });
