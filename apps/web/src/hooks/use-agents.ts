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

export const useAgentGranularAccess = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.agents.granularAccess(),
    queryFn: agents.granularAccess,
    enabled,
  });

export const useAgentSecrets = (agentId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.agents.secrets(agentId),
    queryFn: () => agents.secrets(agentId),
    enabled: enabled && agentId.length > 0,
  });

export const useAgentConnections = (agentId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.agents.connections(agentId),
    queryFn: () => agents.connections(agentId),
    enabled: enabled && agentId.length > 0,
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

// Credential-access mutations. These invalidate only the React Query cache;
// the audited API routes invalidate the gateway cache server-side (withAudit),
// and the caller (the manage-access dialog) shows a single consolidated toast,
// so these are intentionally headless (no gateway call, no per-hook toast).
// The mode + connection mutations also refresh the connection→agents reverse
// view (app-page connection cards, keyed under connections.*), which mirrors
// this access; secrets aren't shown there, so useUpdateAgentSecrets doesn't.

export const useUpdateSecretMode = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      mode,
    }: {
      agentId: string;
      mode: "all" | "selective";
    }) => agents.updateSecretMode(agentId, mode),
    onSuccess: (_data, { agentId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.secrets(agentId) });
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
    },
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
    }) => agents.updateSecrets(agentId, secretIds),
    onSuccess: (_data, { agentId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.secrets(agentId) });
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
    },
  });
};

export const useUpdateAgentConnections = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      connections,
    }: {
      agentId: string;
      connections: {
        appConnectionId: string;
        sessionPolicy?: Record<string, unknown> | null;
      }[];
    }) => agents.updateConnections(agentId, connections),
    onSuccess: (_data, { agentId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.agents.connections(agentId) });
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
    },
  });
};
