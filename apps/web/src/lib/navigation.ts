import { CAPS } from "@/lib/env";

/**
 * Matches `/p/<projectId>` at the start of a pathname and captures the id.
 * Shared across sidebar, header, and navigation helpers so the pattern stays
 * consistent.
 */
export const PROJECT_PATH_RE = /^\/p\/([^/]+)(?=\/|$)/;

/**
 * Whether `pathname` is inside a project scope for project-scoped UI (the
 * approvals bell + pending-approvals poll). In editions with URL-scoped
 * tenancy (`orgScopedUI`: cloud, onprem-full) only `/p/<id>` routes are —
 * project context comes from the URL. In flat single-project editions (OSS,
 * onprem-slim) every dashboard page is: the gateway resolves the caller's
 * default project server-side.
 *
 * Distinct from `getProjectId()` (`@/lib/api-fetch`), which answers "which
 * project id does the URL carry" — `undefined` in flat editions by design.
 */
export const hasProjectContext = (pathname: string): boolean =>
  CAPS.orgScopedUI ? PROJECT_PATH_RE.test(pathname) : true;

/** Matches `/org/<orgId>` at the start of a pathname and captures the id. */
export const ORG_PATH_RE = /^\/org\/([^/]+)(?=\/|$)/;

/**
 * Prefix an absolute dashboard path with `/p/<projectId>` if the current
 * pathname is already inside a project scope. Used by shared dashboard
 * components (connections tabs, overview cards, app detail) so a "Secrets"
 * tab click inside `/p/<id>/connections` keeps the project prefix instead of
 * jumping to the OSS top-level `/connections/secrets`.
 *
 * In OSS the regex never matches (no `/p/<id>/` URLs exist) so the input
 * path is returned unchanged — this is a no-op for self-hosted users.
 */
export const withProjectPrefix = (
  currentPathname: string,
  targetPath: string,
): string => {
  const match = currentPathname.match(PROJECT_PATH_RE);
  if (!match) return targetPath;
  return `/p/${match[1]}${targetPath}`;
};

/** The agent detail page, scoped to the current edition (OSS `/agents/<id>`,
 * cloud `/p/<projectId>/agents/<id>` — the bare path 404s there). */
export const agentPath = (currentPathname: string, agentId: string): string =>
  withProjectPrefix(currentPathname, `/agents/${agentId}`);

/** The last-visited org, written client-side on org pages (EE) and read by the
 * Get Started button on account routes (shared, inert in OSS — no account
 * paths exist there). One definition so writer and reader can't drift. */
export const DEFAULT_ORG_COOKIE = "onecli-default-org";

export const readDefaultOrgCookie = (): string | undefined =>
  document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${DEFAULT_ORG_COOKIE}=`))
    ?.split("=")[1];

/**
 * Resolve a path inside the connections section, scoped to the current edition
 * and page. Single source of truth so callers never hardcode the bare OSS
 * `/connections...` path (which 404s in the cloud edition under `/p` or `/org`).
 *
 * - OSS:           `/connections{sub}`
 * - Cloud project: `/p/<id>/connections{sub}`   (derived from `pathname`)
 * - Cloud org:     `<basePath>{sub}`            (basePath = `/org/<id>/global-connections`)
 *
 * `sub` is the path under the connections root, e.g. "" (root),
 * `/apps/<provider>`, or `/vaults/<provider>`.
 */
export const connectionsPath = (
  { pathname, basePath }: { pathname: string; basePath?: string },
  sub = "",
): string =>
  basePath
    ? `${basePath}${sub}`
    : withProjectPrefix(pathname, `/connections${sub}`);
