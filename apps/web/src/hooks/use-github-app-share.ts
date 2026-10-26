"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { githubAppShare } from "@/lib/api";
import type { PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { useInvalidateGrants } from "@/hooks/use-grants";
import { useOrgMembership } from "@/hooks/use-org";

/** The provider whose installations can be shared across the org. */
export const GITHUB_APP_PROVIDER = "github-app";

// GitHub App installations already connected somewhere in the org. One
// connection per installation: one connected in another workspace is shared
// with the whole org (it moves up), never copied. Sharing is an org-admin act
// (the routes refuse anyone else), so members never fetch the list and keep
// the regular install flow. The route audits and flushes the gateway.

/** Installations the caller may share here. Disabled for non-admins (no
 * data: callers fall back to the install flow). */
export const useSharedGitHubInstallations = (
  scope: PageScope = "workspace",
  enabled = true,
) => {
  const { data: membership } = useOrgMembership(enabled);
  return useQuery({
    queryKey: queryKeys.connections.githubInstallations(scope),
    queryFn: () => githubAppShare.listInstallations(scope),
    enabled: enabled && membership?.isAdmin === true,
    staleTime: 0,
    refetchOnMount: "always",
  });
};

/** Share an installation with the whole org: its connection moves up (same
 * id), so every connection and grant view re-reads. Shared from an agent's
 * page, the API also turns it on for that agent. */
export const useShareGitHubInstallation = (scope: PageScope = "workspace") => {
  const invalidateGrants = useInvalidateGrants();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { sourceConnectionId: string; agentId?: string }) =>
      githubAppShare.shareWithOrganization(input, scope),
    onSuccess: () => {
      invalidateGrants();
      void qc.invalidateQueries({ queryKey: queryKeys.connections.all() });
      void qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
    },
  });
};

/** Explicitly refresh a connection's repositories and persisted metadata.
 * POST is deliberate: Resources policy validation needs the refreshed list.
 * Never retry or refresh on incidental focus/reconnect events. */
export const useGitHubConnectionRepos = (
  connectionId: string,
  scope: PageScope = "workspace",
  enabled = true,
) => {
  const qc = useQueryClient();
  return useQuery({
    queryKey: queryKeys.connections.githubConnectionRepos(connectionId, scope),
    queryFn: async () => {
      const result = await githubAppShare.refreshConnectionRepositories(
        connectionId,
        scope,
      );
      // The stored list just changed: views built on it re-read.
      void qc.invalidateQueries({
        queryKey: queryKeys.connections.list(scope),
      });
      return result;
    },
    enabled: enabled && !!connectionId,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
};

/** Change which repos a connection reaches (null = all). The server flushes
 * the gateway; every connection view re-reads. */
export const useSetGitHubConnectionRepos = (scope: PageScope = "workspace") => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      connectionId: string;
      repositories: string[] | null;
    }) =>
      githubAppShare.setConnectionRepositories(
        input.connectionId,
        input.repositories,
        scope,
      ),
    onSuccess: () => {
      // The generic grants invalidator sweeps connections too, which would
      // repeat this dialog's audited refresh POST. Refresh the read views only.
      void qc.invalidateQueries({ queryKey: queryKeys.grants.all() });
      void qc.invalidateQueries({ queryKey: queryKeys.policy.all() });
      void qc.invalidateQueries({ queryKey: queryKeys.agents.all() });
      void qc.invalidateQueries({
        queryKey: queryKeys.connections.all(),
        predicate: (query) =>
          !query.queryKey.includes("github-connection-repos"),
      });
    },
  });
};
