"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { connections } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { getVaultConnections } from "@/lib/actions/connections";
import { invalidateGatewayCache } from "@/lib/actions/gateway-cache";

export const useConnections = () =>
  useQuery({
    queryKey: queryKeys.connections.list(),
    queryFn: connections.list,
  });

export const useVaultConnections = () =>
  useQuery({
    queryKey: queryKeys.vaults.list(),
    queryFn: getVaultConnections,
  });

export const useRenameConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      connections.rename(id, label),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      invalidateGatewayCache();
    },
    onError: () => toast.error("Failed to rename connection"),
  });
};

export const useDisconnectConnection = (
  scope: "project" | "organization" = "project",
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => connections.disconnect(id, scope),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
      invalidateGatewayCache();
    },
    onError: () => toast.error("Failed to disconnect"),
  });
};
