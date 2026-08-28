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

// Scope-aware variant for the org/workspace policy editor: reads /v1/org/secrets on
// org pages (workspace-scoped /v1/secrets 401s there — no X-Workspace-Id) and the
// org/workspace's OWN secrets only. Keys DISTINCT from the connections pages'
// [...secrets.list(), scope] cache because the fetchers differ at org scope
// (server action vs /v1/org/secrets — sharing a key would dedupe two different
// queryFns onto one entry), yet still under secrets.all() so a create/delete
// invalidates it.
export const useScopedSecrets = (scope: PageScope = "workspace") =>
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
      // Creating an LLM key auto-attaches it to keyless agents, so this is a
      // grant write as well as a secret write — refresh both views.
      qc.invalidateQueries({ queryKey: queryKeys.grants.all() });
      qc.invalidateQueries({ queryKey: queryKeys.policy.all() });
      qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
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
