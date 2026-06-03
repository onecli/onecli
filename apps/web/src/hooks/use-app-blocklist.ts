"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { appBlocklist } from "@/lib/api";
import type { PageScope } from "@/lib/api/app-blocklist";
import { queryKeys } from "@/lib/api/keys";
import { invalidateGatewayCache } from "@/lib/actions/gateway-cache";

export const useAppBlocklist = (
  provider: string,
  scope: PageScope,
  enabled = true,
) =>
  useQuery({
    queryKey: queryKeys.appBlocklist.byProvider(provider),
    queryFn: () => appBlocklist.list(provider, scope),
    enabled,
  });

export const useToggleBlocklistRule = (provider: string, scope: PageScope) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, enabled }: { ruleId: string; enabled: boolean }) =>
      appBlocklist.toggle(provider, ruleId, enabled, scope),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.appBlocklist.byProvider(provider),
      });
      invalidateGatewayCache();
    },
    onError: () => toast.error("Failed to update blocklist"),
  });
};

export const useActivateBlocklistHost = (
  provider: string,
  scope: PageScope,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hostId: string) =>
      appBlocklist.activateHost(provider, hostId, scope),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.appBlocklist.byProvider(provider),
      });
      invalidateGatewayCache();
    },
    onError: () => toast.error("Failed to activate blocklist host"),
  });
};

export const useAddBlocklistRule = (provider: string, scope: PageScope) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      name,
      hostPattern,
    }: {
      name: string;
      hostPattern: string;
    }) => appBlocklist.addCustom(provider, name, hostPattern, scope),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.appBlocklist.byProvider(provider),
      });
      invalidateGatewayCache();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Failed to add host"),
  });
};

export const useRemoveBlocklistRule = (provider: string, scope: PageScope) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ruleId: string) =>
      appBlocklist.remove(provider, ruleId, scope),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: queryKeys.appBlocklist.byProvider(provider),
      });
      invalidateGatewayCache();
    },
    onError: () => toast.error("Failed to remove host"),
  });
};
