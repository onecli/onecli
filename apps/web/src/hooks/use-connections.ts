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
