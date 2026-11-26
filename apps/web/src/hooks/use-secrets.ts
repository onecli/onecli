"use client";

import { useQuery } from "@tanstack/react-query";
import { secrets } from "@/lib/api";
import type { PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

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
