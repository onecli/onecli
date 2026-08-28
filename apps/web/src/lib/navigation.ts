/**
 * Matches `/w/<workspaceId>` at the start of a pathname and captures the id.
 * Shared across sidebar, header, and navigation helpers so the pattern stays
 * consistent.
 */
export const WORKSPACE_PATH_RE = /^\/w\/([^/]+)(?=\/|$)/;

/**
 * Whether `pathname` is inside a workspace scope for workspace-scoped UI (the
 * approvals bell + pending-approvals poll). Only `/w/<id>` routes are —
 * workspace context comes from the URL, identically in both editions (the
 * whole dashboard is org-scoped).
 *
 * Distinct from `getWorkspaceId()` (`@/lib/api-fetch`), which answers "which
 * workspace id does the URL carry" — `undefined` in flat editions by design.
 */
export const hasWorkspaceContext = (pathname: string): boolean =>
  WORKSPACE_PATH_RE.test(pathname);

/** Matches `/org/<orgId>` at the start of a pathname and captures the id. */
export const ORG_PATH_RE = /^\/org\/([^/]+)(?=\/|$)/;

/** `/w/<workspaceId>/agents/<agentId>[/<section>]` — the agent page and the
 *  section under it. */
const AGENT_PAGE_RE = /^\/w\/[^/]+\/agents\/([^/]+)(?:\/([^/]*))?/;

export interface AgentPageMatch {
  agentId: string;
  /** The section under the agent page; `""` is the index (it redirects). */
  section: string;
}

/**
 * Read an agent-page URL. One matcher, because three surfaces need the same
 * two facts — the dashboard chrome (is this the full-height agent page?), the
 * header breadcrumb (which agent?) and the agent crumb's switcher (which
 * section do we hold?) — and hand-rolled copies of this shape drifted apart
 * the last time they existed.
 */
export const matchAgentPage = (pathname: string): AgentPageMatch | null => {
  const [, agentId, section] = pathname.match(AGENT_PAGE_RE) ?? [];
  return agentId === undefined ? null : { agentId, section: section ?? "" };
};

/**
 * Whether `pathname` is inside an agent's own page. The one workspace surface
 * that owns its full height and scroll (§3.18: the agent is the thread, and
 * the Chat section needs the raw flex cell, not the `max-w-6xl` scrolling
 * page), so the dashboard chrome hands the whole detail subtree its frame.
 */
export const isAgentPagePath = (pathname: string): boolean =>
  matchAgentPage(pathname) !== null;

/**
 * Prefix an absolute dashboard path with `/w/<workspaceId>` from the current
 * pathname. Used by shared dashboard components (connections tabs, overview
 * cards, app detail) so a "Secrets" tab click inside `/w/<id>/connections`
 * resolves to `/w/<id>/connections/secrets`.
 *
 * The whole dashboard is org-scoped — a bare `/agents`-style path 404s
 * everywhere — so outside a workspace scope this degrades to the org's workspaces
 * list (or home when even the org is unknown) instead of returning the bare
 * `targetPath`. Callers rendered on org-level pages should pass explicit
 * org-scoped hrefs rather than rely on this degradation.
 */
export const withWorkspacePrefix = (
  currentPathname: string,
  targetPath: string,
): string => {
  const match = currentPathname.match(WORKSPACE_PATH_RE);
  if (match) return `/w/${match[1]}${targetPath}`;
  const orgMatch = currentPathname.match(ORG_PATH_RE);
  return orgMatch ? `/org/${orgMatch[1]}/workspaces` : "/";
};

/** The agent detail page. Agents are workspace-scoped
 * (`/w/<workspaceId>/agents/<id>`), so this only resolves fully inside a
 * workspace scope — elsewhere it degrades like `withWorkspacePrefix`. The id is
 * percent-encoded: ids normally come from our API, but a crafted value would
 * otherwise splice extra path segments into the link. */
export const agentPath = (currentPathname: string, agentId: string): string =>
  withWorkspacePrefix(
    currentPathname,
    `/agents/${encodeURIComponent(agentId)}`,
  );

/** A section of the agent page (`/chat`, `/instructions`, …). `section` is
 * one of our own literals, never user input; `""` is the index, which
 * redirects to the agent's first section. */
export const agentSectionPath = (
  currentPathname: string,
  agentId: string,
  section: string,
): string => {
  const base = agentPath(currentPathname, agentId);
  return section === "" ? base : `${base}/${section}`;
};

/**
 * Where "Get Started" lands: the workspace's agent roster with its create flow
 * already open (`?new=1`). Creating the first agent IS getting started — the
 * install instructions come after there is something to install.
 *
 * The param, not local state, so every entry point (the header button, the
 * org-scope picker, a pasted link) opens the same door; the roster strips it
 * once consumed so a refresh doesn't reopen the dialog.
 */
export const AGENT_CREATE_PARAM = "new";

export const agentsCreatePath = (workspaceId: string): string =>
  `/w/${encodeURIComponent(workspaceId)}/agents?${AGENT_CREATE_PARAM}=1`;

/**
 * An agent's Chat section, addressed by workspace id rather than by the
 * current pathname — what every "take me to the agent" caller needs (the
 * header button, the org-scope picker, the create dialog), none of which can
 * use `agentSectionPath`: they name a workspace the current URL may not be in.
 * Both ids are percent-encoded so a crafted value can't splice extra segments.
 */
export const agentChatPath = (workspaceId: string, agentId: string): string =>
  `/w/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/chat`;

/**
 * Marks an arrival that should open with a prefilled first message ("Hey
 * <Agent>, what can you do for me?"). A param, not local state, because the
 * onboarding flow navigates to a fresh page — and the chat strips it once
 * consumed so a refresh doesn't refill a draft the user cleared.
 */
export const CHAT_GREETING_PARAM = "hello";

/** The agent's chat, opened with the greeting draft prefilled. */
export const agentChatGreetingPath = (
  workspaceId: string,
  agentId: string,
): string => `${agentChatPath(workspaceId, agentId)}?${CHAT_GREETING_PARAM}=1`;

/** The prefilled first message. One definition so the copy can't drift. */
export const agentGreetingDraft = (agentName: string): string =>
  `Hey ${agentName.trim()}, what can you do for me?`;

/** The last-visited org, written client-side on org pages and read by the
 * Get Started button on account routes (which belong to no org). One
 * definition so writer and reader can't drift. */
export const DEFAULT_ORG_COOKIE = "onecli-default-org";

export const readDefaultOrgCookie = (): string | undefined =>
  document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${DEFAULT_ORG_COOKIE}=`))
    ?.split("=")[1];

/**
 * Resolve a path inside the connections section, scoped to the current page.
 * Single source of truth so callers never hardcode a bare `/connections...`
 * path (which 404s everywhere on the org-scoped surface).
 *
 * - Workspace page: `/w/<id>/connections{sub}`            (derived from `pathname`)
 * - Org page:     `<basePath>{sub}` when given, else
 *                 `/org/<id>/global-connections{sub}`   (derived from `pathname`)
 *
 * `sub` is the path under the connections root, e.g. "" (root),
 * `/apps/<provider>`, or `/vaults/<provider>`.
 */
export const connectionsPath = (
  { pathname, basePath }: { pathname: string; basePath?: string },
  sub = "",
): string => {
  if (basePath) return `${basePath}${sub}`;
  const workspaceMatch = pathname.match(WORKSPACE_PATH_RE);
  if (workspaceMatch) return `/w/${workspaceMatch[1]}/connections${sub}`;
  const orgMatch = pathname.match(ORG_PATH_RE);
  if (orgMatch) return `/org/${orgMatch[1]}/global-connections${sub}`;
  return "/";
};
