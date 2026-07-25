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
