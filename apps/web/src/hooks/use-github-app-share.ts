"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { githubAppShare } from "@/lib/api";
import type { PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import { useInvalidateGrants } from "@/hooks/use-grants";
import { useOrgMembership } from "@/hooks/use-org";

/** The provider whose installations can be shared across the org. */
export const GITHUB_APP_PROVIDER = "github-app";

// GitHub App installations already connected somewhere in the org, reusable
// from this scope without a new GitHub install. Sharing is an org-admin act
// (the routes refuse anyone else), so members never fetch the list and keep
// the regular install flow. The create route audits and flushes the gateway
// cache server-side.

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
  });
};

export const useGitHubInstallationRepos = (
  sourceConnectionId: string | null,
  scope: PageScope = "workspace",
) =>
  useQuery({
    queryKey: queryKeys.connections.githubInstallationRepos(
      sourceConnectionId ?? "",
    ),
    queryFn: () => githubAppShare.listRepos(sourceConnectionId ?? "", scope),
    enabled: !!sourceConnectionId,
    staleTime: 60_000,
  });

/** A new shared connection arrives already granted to every agent of a
 * workspace (the API's auto-attach), so every grant view refreshes. */
export const useCreateSharedGitHubConnection = (
  scope: PageScope = "workspace",
) => {
  const invalidateGrants = useInvalidateGrants();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      sourceConnectionId: string;
      repositories?: string[];
    }) => githubAppShare.createConnection(input, scope),
    onSuccess: () => {
      invalidateGrants();
      qc.invalidateQueries({ queryKey: queryKeys.counts.all() });
    },
  });
};
