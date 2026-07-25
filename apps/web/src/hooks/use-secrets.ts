"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { secrets } from "@/lib/api";
import type { PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { deleteSecret, updateSecret } from "@/lib/actions/secrets";
import { invalidateGatewayCache } from "@/lib/api/cache";

export const useSecrets = () =>
  useQuery({ queryKey: queryKeys.secrets.list(), queryFn: secrets.list });

// Scope-aware variant for the org/project policy editor: reads /v1/org/secrets on
// org pages (project-scoped /v1/secrets 401s there — no X-Project-Id) and the
// org/project's OWN secrets only. Uses a key DISTINCT from the connections pages'
// partner-inclusive [...secrets.list(), scope] cache (a policy target can't name
// a partner secret), yet still under secrets.all() so a create/delete invalidates
// it.
export const useScopedSecrets = (scope: PageScope = "project") =>
  useQuery({
    queryKey: [...queryKeys.secrets.list(), scope, "policy-target"],
    queryFn: () => secrets.listScoped(scope),
  });

export const useCreateSecret = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: secrets.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.secrets.all() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
      invalidateGatewayCache();
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to create secret",
      ),
  });
};

export const useDeleteSecret = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteSecret,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.secrets.all() });
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
      invalidateGatewayCache();
      toast.success("Secret deleted");
    },
    onError: () => toast.error("Failed to delete secret"),
  });
};

export const useUpdateSecret = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      secretId,
      input,
    }: {
      secretId: string;
      input: Parameters<typeof updateSecret>[1];
    }) => updateSecret(secretId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.secrets.all() });
      invalidateGatewayCache();
      toast.success("Secret updated");
    },
    onError: () => toast.error("Failed to update secret"),
  });
};
