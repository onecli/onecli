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

export const useDisconnectConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: connections.disconnect,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
      invalidateGatewayCache();
    },
    onError: () => toast.error("Failed to disconnect"),
  });
};
