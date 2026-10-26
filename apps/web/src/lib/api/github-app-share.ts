import { apiGet, apiPatch, apiPost } from "./client";
import { appsPath, type PageScope } from "./scope";

/** A GitHub App installation already connected somewhere in the org. */
export interface SharedGitHubInstallation {
  sourceConnectionId: string;
  installationId: string;
  account: string | null;
  accountType: string | null;
  avatarUrl: string | null;
  connectedHere: number;
}

export interface SharedGitHubConnection {
  id: string;
  provider: string;
  label: string | null;
}

export const listInstallations = (scope: PageScope = "workspace") =>
  apiGet<SharedGitHubInstallation[]>(
    appsPath(scope, "/github-app/installations"),
  );

/** Share an installation with the whole org: its connection moves up. */
export const shareWithOrganization = (
  input: { sourceConnectionId: string; agentId?: string },
  scope: PageScope = "workspace",
) =>
  apiPost<SharedGitHubConnection>(
    appsPath(scope, "/github-app/connections"),
    input,
  );

/** A connection's repositories: live from GitHub (`selected` null = all). */
export interface ConnectionRepositories {
  available: string[];
  truncated: boolean;
  selected: string[] | null;
}

export const refreshConnectionRepositories = (
  connectionId: string,
  scope: PageScope = "workspace",
) =>
  apiPost<ConnectionRepositories>(
    appsPath(
      scope,
      `/github-app/connections/${encodeURIComponent(connectionId)}/repository-refresh`,
    ),
    {},
  );

/** `repositories` null = every repo the installation covers. */
export const setConnectionRepositories = (
  connectionId: string,
  repositories: string[] | null,
  scope: PageScope = "workspace",
) =>
  apiPatch<{ id: string; repositories: string[] | null }>(
    appsPath(
      scope,
      `/github-app/connections/${encodeURIComponent(connectionId)}`,
    ),
    { repositories },
  );
