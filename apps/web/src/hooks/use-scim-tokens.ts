"use client";

// No gateway involvement: SCIM tokens gate the provisioning endpoint, not
// agent traffic — nothing here flushes the gateway cache.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { scimTokens } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

export const useScimTokens = () =>
  useQuery({
    queryKey: queryKeys.scimTokens.list(),
    queryFn: () => scimTokens.list(),
  });

export const useCreateScimToken = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => scimTokens.create(label),
    onSuccess: () => {
      // No success toast — the show-once dialog IS the confirmation.
      qc.invalidateQueries({ queryKey: queryKeys.scimTokens.all() });
    },
    onError: (err) => toast.error(err.message),
  });
};

export const useRevokeScimToken = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => scimTokens.revoke(tokenId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.scimTokens.all() });
      toast.success(
        "Token revoked — provisioning requests with it stop immediately",
      );
    },
    onError: () => toast.error("Failed to revoke token"),
  });
};
