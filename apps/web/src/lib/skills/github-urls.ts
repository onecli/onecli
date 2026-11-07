/** Each segment of a slash path encoded on its own: the slashes stay
 * slashes, anything else (spaces, `#`, `?`) can't break the URL. */
const encodePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

/**
 * A folder of a repo at a commit or branch, on GitHub. The ref and the path
 * are encoded segment by segment, so `feature/x` and a folder named with
 * spaces or `#` both link to themselves.
 */
export const githubTreeUrl = (repo: string, ref: string, path = "") => {
  const base = `https://github.com/${repo}/tree/${encodePath(ref)}`;
  return path ? `${base}/${encodePath(path)}` : base;
};

/** The GitHub page that manages a GitHub App installation's repos. */
export const githubInstallationUrl = (installation: {
  installationId: string;
  account: string | null;
  accountType: string | null;
}) =>
  installation.accountType === "Organization" && installation.account
    ? `https://github.com/organizations/${encodeURIComponent(installation.account)}/settings/installations/${encodeURIComponent(installation.installationId)}`
    : `https://github.com/settings/installations/${encodeURIComponent(installation.installationId)}`;
