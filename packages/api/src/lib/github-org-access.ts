// Pure, dependency-free helpers for a GitHub OAuth connection's
// per-organization access state. Client components import these, so this
// module must stay leaf-only (no DB, crypto, or service imports).
//
// The gateway records an organization that refused the connection's token
// under `metadata.githubOrgAccess.<org>` (see the gateway's
// `github_org_access` module) and drops it on a reconnect or once the refused
// request goes through. This module reads that record and builds the GitHub
// links and admin message the dashboard shows for it.

/** The app whose OAuth connection the gateway records refusals for. A GitHub
 * App installation is authorized by the installation itself, so it never
 * has these refusals. */
export const GITHUB_OAUTH_PROVIDER = "github";

/** `approval_required`: the organization restricts OAuth apps and has not
 * approved OneCLI. `sso_required`: the organization enforces SAML SSO and the
 * connection was authorized without an active SSO session. */
export type GitHubOrgAccessReason = "approval_required" | "sso_required";

export interface GitHubOrgAccessIssue {
  org: string;
  reason: GitHubOrgAccessReason;
}

/** GitHub organization logins: alphanumerics and inner hyphens, ≤ 39 chars.
 * The same rule the gateway applies before recording, re-checked here so a
 * value can be placed in a URL without encoding surprises. */
export const isGitHubOrgLogin = (value: string): boolean =>
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);

const isReason = (value: unknown): value is GitHubOrgAccessReason =>
  value === "approval_required" || value === "sso_required";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every recorded organization refusal on a connection, sorted by org name.
 * Malformed entries are skipped. */
export const extractGitHubOrgAccess = (
  metadata: unknown,
): GitHubOrgAccessIssue[] => {
  if (!isRecord(metadata)) return [];
  const record = metadata.githubOrgAccess;
  if (!isRecord(record)) return [];
  const issues: GitHubOrgAccessIssue[] = [];
  for (const [org, entry] of Object.entries(record)) {
    if (!isRecord(entry) || !isGitHubOrgLogin(org) || !isReason(entry.reason))
      continue;
    issues.push({ org, reason: entry.reason });
  }
  return issues.sort((a, b) => a.org.localeCompare(b.org));
};

/** The first of `connections` that records a refusal for `org`
 * (case-insensitive, as GitHub logins are), with that refusal; undefined
 * once none records it. */
export const findGitHubOrgAccess = <C extends { metadata?: unknown }>(
  connections: readonly C[],
  org: string,
): { connection: C; issue: GitHubOrgAccessIssue } | undefined => {
  const wanted = org.toLowerCase();
  for (const connection of connections) {
    const issue = extractGitHubOrgAccess(connection.metadata).find(
      (i) => i.org.toLowerCase() === wanted,
    );
    if (issue) return { connection, issue };
  }
  return undefined;
};

/** The status-line summary for an account some GitHub organizations refused. */
export const githubOrgAccessSummary = (count: number): string =>
  `${count} GitHub org${count === 1 ? " needs" : "s need"} access`;

/** The short status line for an organization's refusal. */
export const githubOrgAccessStatus = (reason: GitHubOrgAccessReason): string =>
  reason === "approval_required"
    ? "Waiting for admin approval"
    : "SSO sign-in needed";

/** Where the user requests an organization's approval: their authorized
 * OAuth apps list. They open OneCLI there and click "Request access" beside
 * the organization; GitHub then notifies its owners. */
export const GITHUB_AUTHORIZED_APPS_URL =
  "https://github.com/settings/applications";

/** Where an organization owner reviews pending OAuth app requests and grants
 * them ("Third-party Access" → "OAuth app policy"). */
export const githubOrgOAuthPolicyUrl = (org: string): string =>
  `https://github.com/organizations/${encodeURIComponent(org)}/settings/oauth_application_policy`;

/** Starts an SSO session for the organization, after which a reconnect
 * authorizes the connection for it. */
export const githubOrgSsoUrl = (org: string): string =>
  `https://github.com/orgs/${encodeURIComponent(org)}/sso`;

/** The message the user sends an organization owner. Plain text, so it pastes
 * cleanly into Slack or email. */
export const githubOrgAdminMessage = (org: string): string =>
  [
    `Hi, I'm requesting access for OneCLI to our GitHub organization ${org}.`,
    `Could you approve it here: ${githubOrgOAuthPolicyUrl(org)}`,
    `Find OneCLI in the list, click Review, then Grant access. Thanks!`,
  ].join("\n");
