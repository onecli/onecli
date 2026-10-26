"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { appBlocklist } from "@/lib/api";
import type { BlocklistHostState, PageScope } from "@/lib/api/app-blocklist";
import { queryKeys } from "@/lib/api/keys";
import { invalidateGatewayCache } from "@/lib/api/cache";
import { installItem, listItem, patchItem } from "@/lib/api/optimistic";
import { useOptimisticMutation } from "@/hooks/use-optimistic-mutation";

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

const hostRow = (hostId: string) =>
  listItem<BlocklistHostState>((h) => h.hostId === hostId);

const hostName = (qc: QueryClient, provider: string, hostId: string) =>
  qc
    .getQueryData<
      BlocklistHostState[]
    >(queryKeys.appBlocklist.byProvider(provider))
    ?.find((h) => h.hostId === hostId)?.name ?? "the host";

/** A blocklist write changes what the gateway enforces: flush its cache
 * (the client-side door, as before) and refetch the list once per burst. */
const refreshBlocklist = (provider: string) => (qc: QueryClient) => {
  void invalidateGatewayCache();
  return qc.invalidateQueries({
    queryKey: queryKeys.appBlocklist.byProvider(provider),
  });
};

/**
 * Block / unblock one registry host from its switch, instantly. A host with
 * a rule already flips that rule's flag; a host the workspace has never
 * blocked creates its rule (the POST answers with the row, rule id and all).
 * Both are one write per host, ordered per host, rolled back alone. The
 * rule id is read when the write is SENT, not when it was clicked: a quick
 * second click queued behind a create must flip the rule that create made.
 */
export const useSetBlocklistHost = (provider: string, scope: PageScope) => {
  const qc = useQueryClient();
  const ruleIdNow = (host: BlocklistHostState) =>
    qc
      .getQueryData<
        BlocklistHostState[]
      >(queryKeys.appBlocklist.byProvider(provider))
      ?.find((h) => h.hostId === host.hostId)?.ruleId ?? host.ruleId;
  return useOptimisticMutation<
    BlocklistHostState | { success: true },
    { host: BlocklistHostState; enabled: boolean }
  >({
    family: `blocklist:${provider}`,
    itemKey: ({ host }) => `blocklist:${provider}:${host.hostId}`,
    write: ({ host, enabled }) => {
      const ruleId = ruleIdNow(host);
      return ruleId
        ? appBlocklist.toggle(provider, ruleId, enabled, scope)
        : appBlocklist.activateHost(provider, host.hostId, scope);
    },
    apply: (qc, { host, enabled }) =>
      patchItem(
        qc,
        queryKeys.appBlocklist.byProvider(provider),
        hostRow(host.hostId),
        (h) => (h ? { ...h, enabled } : h),
      ),
    confirm: (qc, result, { host }) => {
      // Only the create answers with the row: install it as truth.
      if ("hostId" in result) {
        installItem(
          qc,
          queryKeys.appBlocklist.byProvider(provider),
          hostRow(host.hostId),
          result,
        );
      }
    },
    // The create's new rule id is merged in even when a later click on the
    // host is queued (when `confirm` is skipped): that queued write reads it
    // to flip this rule rather than create a second one. Only the id: the
    // switch keeps showing the newest click.
    succeeded: (result, { host }) => {
      if (!("hostId" in result) || result.ruleId === null) return;
      const ruleId = result.ruleId;
      patchItem(
        qc,
        queryKeys.appBlocklist.byProvider(provider),
        hostRow(host.hostId),
        (h) => (h && h.ruleId !== ruleId ? { ...h, ruleId } : h),
      );
    },
    refresh: refreshBlocklist(provider),
    failure: (qc, { host, enabled }) =>
      `Couldn't ${enabled ? "block" : "unblock"} ${hostName(qc, provider, host.hostId)}`,
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
