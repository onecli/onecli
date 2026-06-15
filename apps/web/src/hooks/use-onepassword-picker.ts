"use client";

import { useQuery } from "@tanstack/react-query";
import {
  getStatus,
  listFields,
  listItems,
  listVaults,
} from "@/lib/api/onepassword";
import { queryKeys } from "@/lib/api/keys";

// Vault contents change rarely within a dialog session; cache briefly so the
// cascading selects feel instant and don't re-hit the gateway on every reopen.
const STALE_TIME = 60_000;

/**
 * Whether 1Password is connected for this project. Deduped across every mounted
 * SecretDialog (one query key), and gated by `enabled` so closed dialogs don't
 * poll the gateway.
 */
export const useOnePasswordReady = (enabled: boolean) => {
  const query = useQuery({
    queryKey: queryKeys.onepassword.status(),
    queryFn: getStatus,
    enabled,
    staleTime: STALE_TIME,
  });
  return { isReady: query.data?.connected ?? false, ...query };
};

export const useOpVaults = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.onepassword.vaults(),
    queryFn: listVaults,
    enabled,
    staleTime: STALE_TIME,
  });

export const useOpItems = (vaultId: string | null) =>
  useQuery({
    queryKey: queryKeys.onepassword.items(vaultId ?? ""),
    queryFn: () => listItems(vaultId as string),
    enabled: !!vaultId,
    staleTime: STALE_TIME,
  });

export const useOpFields = (vaultId: string | null, itemId: string | null) =>
  useQuery({
    queryKey: queryKeys.onepassword.fields(vaultId ?? "", itemId ?? ""),
    queryFn: () => listFields(vaultId as string, itemId as string),
    enabled: !!vaultId && !!itemId,
    staleTime: STALE_TIME,
  });
