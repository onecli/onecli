"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { appConfig } from "@/lib/api";
import type { AppConfigStatus, PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// App-config mutations are headless: the audited API routes invalidate the
// gateway cache server-side (withAudit), and the callers (AppConfigForm,
// ConfigureCredentialsDialog) own the toasts — no gateway call, no per-hook
// toast.

export const useAppConfigStatus = (
  provider: string,
  scope: PageScope,
  enabled = true,
) =>
  useQuery({
    queryKey: queryKeys.appConfig.status(provider, scope),
    queryFn: () => appConfig.get(provider, scope),
    enabled,
  });

export const useConfiguredProviders = (scope: PageScope, enabled = true) =>
  useQuery({
    queryKey: queryKeys.appConfig.configured(scope),
    queryFn: () => appConfig.configuredProviders(scope),
    retry: false,
    enabled,
  });

export const useEnvDefaultProviders = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.appConfig.envDefaults(),
    queryFn: appConfig.envDefaults,
    // Platform env defaults are static per deploy.
    staleTime: Infinity,
    retry: false,
    enabled,
  });

const useInvalidateAppConfig = (provider: string, scope: PageScope) => {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({
      queryKey: queryKeys.appConfig.status(provider, scope),
    });
    qc.invalidateQueries({ queryKey: queryKeys.appConfig.configured(scope) });
    // Config save/delete disconnects live connections server-side.
    qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
    qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
  };
};

export const useSaveAppConfig = (provider: string, scope: PageScope) => {
  const invalidate = useInvalidateAppConfig(provider, scope);
  return useMutation({
    mutationFn: (values: Record<string, string>) =>
      appConfig.save(provider, values, scope),
    onSuccess: invalidate,
  });
};

export const useDeleteAppConfig = (provider: string, scope: PageScope) => {
  const invalidate = useInvalidateAppConfig(provider, scope);
  return useMutation({
    mutationFn: () => appConfig.remove(provider, scope),
    onSuccess: invalidate,
  });
};

export const useToggleAppConfig = (provider: string, scope: PageScope) => {
  const qc = useQueryClient();
  const invalidate = useInvalidateAppConfig(provider, scope);
  const statusKey = queryKeys.appConfig.status(provider, scope);
  return useMutation({
    mutationFn: (enabled: boolean) =>
      appConfig.toggle(provider, enabled, scope),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: statusKey });
      const previous = qc.getQueryData<AppConfigStatus>(statusKey);
      qc.setQueryData<AppConfigStatus>(statusKey, (current) =>
        current ? { ...current, enabled } : current,
      );
      return { previous };
    },
    onError: (_err, _enabled, context) => {
      if (context?.previous) qc.setQueryData(statusKey, context.previous);
    },
    onSettled: invalidate,
  });
};
