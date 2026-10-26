"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/keys";
import * as api from "./api";
import type { ReadAudience } from "./api";

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
    mutationFn: (input: { externalRef: string; audience: ReadAudience }) =>
      api.setGrant(agentId, input.externalRef, input.audience),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: [...k(agentId), "grants"] }),
  });
};

/** Share several of the caller's own conversations in one request. */
export const useShareConversations = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { externalRefs: string[]; audience: ReadAudience }) =>
      api.shareMany(agentId, input.externalRefs, input.audience),
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
