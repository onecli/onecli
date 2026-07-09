"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { connections, vaults } from "@/lib/api";
import type { PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// Connection mutations are headless on the gateway cache: the audited API
// routes invalidate it server-side (withAudit), so there is no client-side
// gateway call here.

export const useConnections = (scope: PageScope = "project") =>
  useQuery({
    queryKey: queryKeys.connections.list(scope),
    queryFn: () => connections.list(scope),
  });

export const useVaultConnections = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.vaults.list(),
    queryFn: vaults.list,
    enabled,
  });

export const useRenameConnection = (scope: PageScope = "project") => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      connections.rename(id, label, scope),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
    },
    onError: () => toast.error("Failed to rename connection"),
  });
};

export const useDisconnectConnection = (scope: PageScope = "project") => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => connections.disconnect(id, scope),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
    },
    onError: () => toast.error("Failed to disconnect"),
  });
};

// Reverse view of agent↔connection access, keyed from the connection side.
export const useConnectionAgents = (connectionId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.connections.agents(connectionId),
    queryFn: () => connections.agents(connectionId),
    enabled: enabled && connectionId.length > 0,
  });

// Headless on the gateway cache (the audited API route flushes it server-side
// via withAudit); the caller shows a single consolidated toast. Invalidates the
// reverse view plus the agents list, whose "N apps" count changes.
export const useSetConnectionAgents = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      connectionId,
      agentIds,
    }: {
      connectionId: string;
      agentIds: string[];
    }) => connections.setAgents(connectionId, agentIds),
    onSuccess: (_data, { connectionId }) => {
      qc.invalidateQueries({
        queryKey: queryKeys.connections.agents(connectionId),
      });
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
    },
  });
};
