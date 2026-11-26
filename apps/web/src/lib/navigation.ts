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

/**
 * Whether `pathname` names an org for the scoped reads (the proxy turns
 * `/w/<id>` and `/org/<id>` into the scope headers): every dashboard URL
 * but the account's, which belongs to the person and names none.
 */
export const isOrgScopedPath = (pathname: string): boolean =>
  hasWorkspaceContext(pathname) || ORG_PATH_RE.test(pathname);

/**
 * Whether `pathname` draws the dashboard: the home page (which forwards
 * into it), and every workspace, org and account URL. What a wait on one
 * of them should look like is the dashboard's own skeleton; any other
 * page (sign-in, onboarding, a join link) has its own look.
 */
export const isDashboardPath = (pathname: string): boolean =>
  pathname === "/" || /^\/(w|org|account)(\/|$)/.test(pathname);

// ── Route builders ──────────────────────────────────────────────────────
//
// Every dashboard URL the app links to, in one place, so a page can move
// by editing a helper rather than hunting template
// literals. The page names are closed unions: a typo is a compile error, and
// a retired page disappears from the union, which flags every link to it.
// Ids are percent-encoded everywhere: they normally come from our own API,
// but a crafted value must not splice extra path segments into a link.

const seg = (id: string) => encodeURIComponent(id);

/** The pages under `/org/<orgId>/`. `""` is the org root (it redirects). */
export type OrgPage =
  | ""
  | "workspaces"
  | "team"
  | "groups"
  | "usage"
  | "billing"
  | "channels"
  | "skills"
  | "settings"
  | "settings/general"
  | "settings/sso"
  | "settings/app-availability"
  | "settings/global-connections"
  | "settings/policy"
  | "settings/org-api-keys"
  | "settings/channels";

export const orgPath = (orgId: string, page: OrgPage = ""): string =>
  page === "" ? `/org/${seg(orgId)}` : `/org/${seg(orgId)}/${page}`;

/**
 * Where "go to this org" lands: the org switcher, every post-join /
 * post-claim / post-create redirect, and the fallbacks that need SOME page
 * of the org. The workspaces URL, which forwards to the first visible
 * workspace's first agent (or shows the empty list). One helper, so the
 * landing moves for all of them at once.
 */
export const orgHomePath = (orgId: string): string =>
  orgPath(orgId, "workspaces");

/** The pages under `/w/<workspaceId>/`. `""` is the workspace root (it
 *  redirects to the first agent). */
export type WorkspacePage =
  | ""
  | "agents"
  | "activity"
  | "connections"
  | "files"
  | "overview"
  | "skills"
  | "settings"
  | "settings/general"
  | "settings/install"
  | "settings/api-key";

export const workspacePath = (
  workspaceId: string,
  page: WorkspacePage = "",
): string =>
  page === "" ? `/w/${seg(workspaceId)}` : `/w/${seg(workspaceId)}/${page}`;

/**
 * `/w/<workspaceId>/agents/<agentId>[/<section>]`, addressed by ids rather
 * than by the current pathname (contrast `agentSectionPath`, which derives
 * the workspace from the URL the caller is on). `section` is one of our own
 * literals (`AgentSection.section`), never user input; `""` is the index,
 * which redirects to the agent's first section.
 */
export const agentPagePath = (
  workspaceId: string,
  agentId: string,
  section = "",
): string => {
  const base = `${workspacePath(workspaceId, "agents")}/${seg(agentId)}`;
  return section === "" ? base : `${base}/${section}`;
};

/** `/w/<workspaceId>/agents/<agentId>[/<section>]` — the agent page and the
 *  section under it. */
const AGENT_PAGE_RE = /^\/w\/[^/]+\/agents\/([^/]+)(?:\/([^/]*))?/;

export interface AgentPageMatch {
  agentId: string;
  /** The section under the agent page; `""` is the index (it redirects). */
  section: string;
}

/**
 * Read an agent-page URL. One matcher, because several surfaces need the
 * same two facts (the dashboard chrome: is this the full-height agent page?
 * the sidebar and rail: which agent, which section?), and hand-rolled
 * copies of this shape drifted apart the last time they existed.
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
 * pathname. Used by shared dashboard components (connections tabs, settings
 * panes, app detail) so a "Secrets" tab click inside `/w/<id>/connections`
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
  const orgId = currentPathname.match(ORG_PATH_RE)?.[1];
  return orgId ? orgHomePath(orgId) : "/";
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

/** A section of the agent page (`/chat`, `/knowledge`, …). `section` is
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
 * The old agent sections that are now one block of a merged page: the page
 * they live on, and the block's anchor. Their URLs still resolve (each is a
 * server redirect that reads this map), but a link we draw goes straight to
 * the block, never through the hop. Slack is the first block on Contacts,
 * so it takes no anchor: the jump would scroll the page's own header out of
 * view.
 */
export const MERGED_AGENT_SECTIONS: Record<
  "instructions" | "skills" | "memory" | "models" | "ssh" | "channels",
  { page: string; anchor?: string }
> = {
  instructions: { page: "knowledge", anchor: "instructions" },
  skills: { page: "knowledge", anchor: "skills" },
  memory: { page: "knowledge", anchor: "memory" },
  models: { page: "settings", anchor: "models" },
  ssh: { page: "settings", anchor: "ssh" },
  channels: { page: "contacts" },
};

export type MergedAgentSection = keyof typeof MERGED_AGENT_SECTIONS;

/** `?query#anchor` for a merged section: the query rides before the anchor,
 *  as a URL wants it. `query` is already encoded, with no leading `?`. */
const mergedSuffix = (section: MergedAgentSection, query: string): string => {
  const { anchor } = MERGED_AGENT_SECTIONS[section];
  return `${query ? `?${query}` : ""}${anchor ? `#${anchor}` : ""}`;
};

/** A merged section's block on its page, in the current workspace:
 *  `/w/<id>/agents/<agentId>/knowledge#skills`. */
export const mergedSectionPath = (
  currentPathname: string,
  agentId: string,
  section: MergedAgentSection,
  query = "",
): string =>
  `${agentSectionPath(currentPathname, agentId, MERGED_AGENT_SECTIONS[section].page)}${mergedSuffix(section, query)}`;

/** `mergedSectionPath` addressed by ids, for a caller outside the agent's
 *  workspace URL (the org's Slack page, the install return, the redirect
 *  that serves the old URLs). */
export const mergedAgentPagePath = (
  workspaceId: string,
  agentId: string,
  section: MergedAgentSection,
  query = "",
): string =>
  `${agentPagePath(workspaceId, agentId, MERGED_AGENT_SECTIONS[section].page)}${mergedSuffix(section, query)}`;

/**
 * The agent's Computer page. With `requestId`, a deep link to that ask: the
 * page focuses Take control (a focus hint only, never the lease itself) and
 * then drops the param, so a refresh doesn't replay it. The API's own link
 * (the Slack card) builds the same shape.
 */
export const DESKTOP_TAKEOVER_PARAM = "takeover";
export const agentComputerPath = (
  currentPathname: string,
  agentId: string,
  requestId?: string,
): string => {
  const path = agentSectionPath(currentPathname, agentId, "computer");
  return requestId === undefined
    ? path
    : `${path}?${new URLSearchParams({ [DESKTOP_TAKEOVER_PARAM]: requestId }).toString()}`;
};

/** The agent's chat with a message ready to finish and send (`?draft=`,
 * read once by the chat). */
export const agentChatDraftPath = (
  currentPathname: string,
  agentId: string,
  draft: string,
): string =>
  `${agentSectionPath(currentPathname, agentId, "chat")}?draft=${encodeURIComponent(draft)}`;

/**
 * Where "Get Started" lands: the workspace's agents page with its create flow
 * already open (`?new=1`). Creating the first agent IS getting started — the
 * install instructions come after there is something to install.
 *
 * The param, not local state, so every entry point (the header button, the
 * org-scope picker, a pasted link) opens the same door; the agents page strips it
 * once consumed so a refresh doesn't reopen the dialog.
 */
export const AGENT_CREATE_PARAM = "new";

/**
 * `?new=primary`: open the create door's PRIMARY action (BYO creation for a
 * BYO-world org, hosted creation otherwise) rather than the hosted-intent
 * default of any other value. For entry points that are not about hosted
 * agents, e.g. Install's "New agent" option.
 */
export const AGENT_CREATE_PRIMARY = "primary";

/**
 * An agent's Chat section, addressed by workspace id rather than by the
 * current pathname — what every "take me to the agent" caller needs (the
 * header button, the org-scope picker, the create dialog), none of which can
 * use `agentSectionPath`: they name a workspace the current URL may not be in.
 * Both ids are percent-encoded so a crafted value can't splice extra segments.
 */
export const agentChatPath = (workspaceId: string, agentId: string): string =>
  agentPagePath(workspaceId, agentId, "chat");

/**
 * The workspace's Files section — the download page for one file an agent
 * sent (send_file), addressed for a link that lives OUTSIDE the web (a Slack
 * degrade line, an email). Workspace and attachment in the path, the
 * conversation as a query param: the chat only renders direct threads, so
 * this page is the one web door a channel thread's file has. It sits at the
 * WORKSPACE level, not inside the agent frame — the person arrives from a
 * link, and a file is a thing in its own right; the page names the agent
 * that sent it. Every id percent-encoded; the channel adapter builds the same
 * shape from its own config (channel-adapter/src/adapter.ts).
 */
export const ATTACHMENT_CONVERSATION_PARAM = "c";
export const workspaceFilesPath = (workspaceId: string): string =>
  workspacePath(workspaceId, "files");
export const workspaceFilePath = (
  workspaceId: string,
  attachmentId: string,
  conversationId: string,
): string =>
  `${workspaceFilesPath(workspaceId)}/${encodeURIComponent(attachmentId)}?${ATTACHMENT_CONVERSATION_PARAM}=${encodeURIComponent(conversationId)}`;

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
 * The org's Shared Connections root, under Organization Settings. The single
 * definition every org-scope connections surface (tabs, apps grid, connected
 * rows, the app page's back link, the settings nav) builds on, so a future
 * move cannot strand one of them on the old URL.
 */
export const orgConnectionsPath = (orgId: string): string =>
  orgPath(orgId, "settings/global-connections");

/**
 * Resolve a path inside the connections section, scoped to the current page.
 * Single source of truth so callers never hardcode a bare `/connections...`
 * path (which 404s everywhere on the org-scoped surface).
 *
 * - Workspace page: `/w/<id>/connections{sub}`            (derived from `pathname`)
 * - Org page:     `<basePath>{sub}` when given, else
 *                 `/org/<id>/settings/global-connections{sub}`   (derived from `pathname`)
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
  const orgId = pathname.match(ORG_PATH_RE)?.[1];
  if (orgId) return `${orgConnectionsPath(orgId)}${sub}`;
  return "/";
};
