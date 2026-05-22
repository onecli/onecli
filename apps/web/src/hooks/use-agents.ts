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
  getAgentSecrets,
  updateAgentSecretMode,
  updateAgentSecrets,
  getAgentAppConnections,
  updateAgentAppConnections,
} from "@/lib/actions/agents";
import { invalidateGatewayCache } from "@/lib/actions/gateway-cache";

export const useAgents = () =>
  useQuery({ queryKey: queryKeys.agents.list(), queryFn: getAgents });

export const useAgentSecrets = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.agents.secrets(agentId),
    queryFn: () => getAgentSecrets(agentId),
  });

export const useAgentConnections = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.agents.connections(agentId),
    queryFn: () => getAgentAppConnections(agentId),
  });

export const useCreateAgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: agents.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
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
      invalidateGatewayCache();
      toast.success("Default agent updated");
    },
    onError: () => toast.error("Failed to set default agent"),
  });
};

export const useUpdateSecretMode = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      mode,
    }: {
      agentId: string;
      mode: "all" | "selective";
    }) => updateAgentSecretMode(agentId, mode),
    onSuccess: (_data, { agentId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
      qc.invalidateQueries({ queryKey: queryKeys.agents.secrets(agentId) });
      invalidateGatewayCache();
    },
    onError: () => toast.error("Failed to update secret mode"),
  });
};

export const useUpdateAgentSecrets = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      secretIds,
    }: {
      agentId: string;
      secretIds: string[];
    }) => updateAgentSecrets(agentId, secretIds),
    onSuccess: (_data, { agentId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.secrets(agentId) });
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
      invalidateGatewayCache();
    },
    onError: () => toast.error("Failed to update agent secrets"),
  });
};

export const useUpdateAgentConnections = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      connectionIds,
    }: {
      agentId: string;
      connectionIds: string[];
    }) => updateAgentAppConnections(agentId, connectionIds),
    onSuccess: (_data, { agentId }) => {
      qc.invalidateQueries({
        queryKey: queryKeys.agents.connections(agentId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
      invalidateGatewayCache();
    },
    onError: () => toast.error("Failed to update agent connections"),
  });
};
