"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { agents } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import {
  getAgents,
  deleteAgent,
  renameAgent,
  regenerateAgentToken,
  setDefaultAgent,
} from "@/lib/actions/agents";
import { invalidateGatewayCache } from "@/lib/api/cache";

export const useAgents = (enabled = true) =>
  useQuery({ queryKey: queryKeys.agents.list(), queryFn: getAgents, enabled });

/** Detail read incl. `recentRequestAt`. With `poll`, refetches every 5s until
 * a request is seen — the Install page's "waiting for the first request"
 * signal — then stops on its own. An errored read (e.g. the agent was deleted
 * mid-wait) also stops the loop instead of hammering a 404 every 5s. */
export const useAgentDetail = (
  agentId: string,
  options: { poll?: boolean } = {},
) =>
  useQuery({
    queryKey: queryKeys.agents.detail(agentId),
    queryFn: () => agents.get(agentId),
    enabled: agentId.length > 0,
    refetchInterval: options.poll
      ? (query) =>
          query.state.error || query.state.data?.recentRequestAt ? false : 5000
      : undefined,
  });

/** Agents of an explicitly-chosen project (the org-level Get Started picker) —
 * everywhere else use `useAgents()`, which follows the URL scope. */
export const useAgentsForProject = (projectId: string) =>
  useQuery({
    queryKey: queryKeys.agents.forProject(projectId),
    queryFn: () => agents.list({ projectId }),
    enabled: projectId.length > 0,
  });

export const useCreateAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: agents.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
      // A new agent appears in the connection→agents reverse view (app-page
      // connection cards, keyed under connections.*) — refresh it too.
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      invalidateGatewayCache();
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to create agent",
      ),
  });
};

export const useDeleteAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteAgent,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
      // Drop the deleted agent from the connection→agents reverse view too.
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      invalidateGatewayCache();
      toast.success("Agent deleted");
    },
    onError: () => toast.error("Failed to delete agent"),
  });
};

export const useRenameAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, name }: { agentId: string; name: string }) =>
      renameAgent(agentId, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
      // The renamed agent is also shown in the connection→agents reverse view.
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      toast.success("Agent renamed");
    },
    onError: () => toast.error("Failed to rename agent"),
  });
};

export const useRegenerateToken = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: regenerateAgentToken,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
      invalidateGatewayCache();
      toast.success("Token regenerated");
    },
    onError: () => toast.error("Failed to regenerate token"),
  });
};

export const useSetDefaultAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: setDefaultAgent,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
      // The connection→agents reverse view orders default-first, so its
      // ordering reflects this change.
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      invalidateGatewayCache();
      toast.success("Default agent updated");
    },
    onError: () => toast.error("Failed to set default agent"),
  });
};
