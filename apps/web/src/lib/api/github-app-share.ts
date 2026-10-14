import { apiGet, apiPost } from "./client";
import { appsPath, type PageScope } from "./scope";

/** A GitHub App installation already connected somewhere in the org. */
export interface SharedGitHubInstallation {
  sourceConnectionId: string;
  installationId: string;
  account: string | null;
  accountType: string | null;
  avatarUrl: string | null;
  /** What the GitHub org owner granted the installation: "all" | "selected". */
  repositorySelection: string | null;
  origin: "this_scope" | "organization" | "another_workspace";
  connectedHere: number;
}

export interface InstallationRepos {
  repos: string[];
  truncated: boolean;
}

export interface CreatedSharedConnection {
  id: string;
  provider: string;
  label: string | null;
}

export const listInstallations = (scope: PageScope = "workspace") =>
  apiGet<SharedGitHubInstallation[]>(
    appsPath(scope, "/github-app/installations"),
  );

export const listRepos = (
  sourceConnectionId: string,
  scope: PageScope = "workspace",
) =>
  apiGet<InstallationRepos>(
    appsPath(
      scope,
      `/github-app/installations/${encodeURIComponent(sourceConnectionId)}/repositories`,
    ),
  );

export const createConnection = (
  input: { sourceConnectionId: string; repositories?: string[] },
  scope: PageScope = "workspace",
) =>
  apiPost<CreatedSharedConnection>(
    appsPath(scope, "/github-app/connections"),
    input,
  );
