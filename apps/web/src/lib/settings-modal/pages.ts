/**
 * The Settings modal's map (plans/flatten-ui.md): every page the
 * modal can show, keyed by the `?settings=<page>` value that opens it.
 *
 * The registry is pure data so the nav (client), the slot page (server) and
 * the tests can all read it. The page BODIES live in `bodies.tsx`: they are
 * the existing route pages, imported as-is, and this file must stay free of
 * them so the client nav can import it without dragging server code along.
 *
 * Scope: a page is reachable from an org URL, a workspace URL, or both.
 * Workspace pages need a workspace to act on; on an org URL the modal has
 * none, so they are hidden there. Org and account pages are reachable from
 * anywhere in the org, since a workspace URL implies its org.
 */

export type SettingsSection = "Workspace" | "Organization" | "Account";

interface SettingsPageMeta {
  /** The `?settings=` value. Stable: it is the deep link. */
  id: SettingsPageId;
  section: SettingsSection;
  /** The nav label. */
  title: string;
  /** Needs a `/w/<id>` URL (the page acts on a workspace). */
  workspace?: true;
  /** Needs manage rights on that workspace (rename, share, delete). */
  manage?: true;
  /** Org admins only (the old `(admin)` route group); members never see it. */
  admin?: true;
  /** Billing editions only (`CAPS.billing`). */
  billing?: true;
  /** Hosted agents only (a runner is registered, §3.13). */
  hosted?: true;
}

export const SETTINGS_PAGES: readonly SettingsPageMeta[] = [
  // Workspace: what this workspace's agents share.
  { id: "apps", section: "Workspace", title: "Apps", workspace: true },
  { id: "activity", section: "Workspace", title: "Activity", workspace: true },
  {
    id: "workspace",
    section: "Workspace",
    title: "Settings",
    workspace: true,
    manage: true,
  },
  // Organization: admin-only administration. Members first: the roster is
  // what admins open Settings for most. Who can use ONE workspace is the
  // Workspace access card under Workspace > Settings, not this list. The
  // workspace entry above is "Settings", so two "General" items never sit
  // a heading apart.
  { id: "members", section: "Organization", title: "Members", admin: true },
  { id: "general", section: "Organization", title: "General", admin: true },
  {
    id: "shared-apps",
    section: "Organization",
    title: "Shared apps",
    admin: true,
  },
  { id: "rules", section: "Organization", title: "Rules", admin: true },
  {
    id: "slack",
    section: "Organization",
    title: "Slack",
    admin: true,
    hosted: true,
  },
  {
    id: "workspaces",
    section: "Organization",
    title: "Workspaces",
    admin: true,
  },
  {
    id: "security",
    section: "Organization",
    title: "Security & SSO",
    admin: true,
  },
  {
    id: "billing",
    section: "Organization",
    title: "Billing & usage",
    admin: true,
    billing: true,
  },
  // Account: the signed-in person.
  { id: "profile", section: "Account", title: "Profile" },
  { id: "api-keys", section: "Account", title: "API keys" },
];

export type SettingsPageId =
  | "members"
  | "apps"
  | "activity"
  | "workspace"
  | "general"
  | "shared-apps"
  | "rules"
  | "slack"
  | "workspaces"
  | "security"
  | "billing"
  | "profile"
  | "api-keys";

/** The query param that opens the modal. */
export const SETTINGS_PARAM = "settings";

/**
 * Params a modal page owns (Activity's tab and filters, the Apps catalog's
 * search and the connections tab, the app or vault a connections page is
 * showing the detail of and that detail's own one-shot params). They mean
 * nothing to another page or to the page under the modal, so moving
 * between pages and closing drop them.
 */
export const PAGE_LOCAL_PARAMS = [
  "tab",
  "agent",
  "view",
  "webhook",
  "schedule",
  "from",
  "to",
  "q",
  "category",
  "app",
  "vault",
  "connected",
  "reconnect",
  "org_access",
] as const;

export const isSettingsPageId = (value: unknown): value is SettingsPageId =>
  typeof value === "string" && SETTINGS_PAGES.some((p) => p.id === value);

export const settingsPage = (id: SettingsPageId): SettingsPageMeta =>
  SETTINGS_PAGES.find((p) => p.id === id)!;

export interface SettingsViewer {
  /** The modal is on a `/w/<id>` URL (workspace pages are reachable). */
  hasWorkspace: boolean;
  /** May rename, share or delete that workspace. */
  canManageWorkspace: boolean;
  /** Org admin or owner (or a non-RBAC edition, where everyone is). */
  isAdmin: boolean;
  /** The deployment sells plans (`CAPS.billing`). */
  billing: boolean;
  /** The deployment has hosted agents (a runner is registered). */
  hosted: boolean;
}

/** The pages this viewer may open, in nav order. One rule for the nav and
 *  the slot page, so a hidden row can never be deep-linked around. */
export const visibleSettingsPages = (
  viewer: SettingsViewer,
): SettingsPageMeta[] =>
  SETTINGS_PAGES.filter(
    (p) =>
      (!p.workspace || viewer.hasWorkspace) &&
      (!p.manage || viewer.canManageWorkspace) &&
      (!p.admin || viewer.isAdmin) &&
      (!p.billing || viewer.billing) &&
      (!p.hosted || viewer.hosted),
  );

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "Workspace",
  "Organization",
  "Account",
];

/**
 * The URL that opens `page` over the current one (or closes the modal, for
 * `null`). Every param the page under the modal owns survives (a chat's
 * `?draft=`); the page-local ones above do not.
 */
export const withSettingsParam = (
  pathname: string,
  search: string,
  page: SettingsPageId | null,
): string => {
  const params = new URLSearchParams(search);
  for (const key of PAGE_LOCAL_PARAMS) params.delete(key);
  if (page) params.set(SETTINGS_PARAM, page);
  else params.delete(SETTINGS_PARAM);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
};

/**
 * A connections sub-page's URL inside the modal: `sub` is what the route
 * pages append to `/connections` (`/apps/<provider>`, `/vaults/<provider>`,
 * `/llms`, or nothing for the catalog), translated to the modal's own
 * params over `pathname`: `?settings=<page>&app=<provider>` and so on.
 * `sub`'s own query (`?connected=<id>` after a connect, `?org_access=`)
 * rides along. Anything page-local already on the URL is dropped first,
 * so a detail opened from a filtered catalog does not keep the filter.
 */
export const connectionsModalHref = (
  pathname: string,
  search: string,
  page: SettingsPageId,
  sub = "",
): string => {
  const [path = "", query] = sub.split("?", 2);
  const params = new URLSearchParams(search);
  for (const key of PAGE_LOCAL_PARAMS) params.delete(key);
  const detail = path.match(/^\/(apps|vaults)\/([^/]+)$/);
  if (detail?.[2]) {
    params.set(detail[1] === "apps" ? "app" : "vault", detail[2]);
  } else {
    const tab = path.replace(/^\//, "");
    if (tab) params.set("tab", tab);
  }
  for (const [key, value] of new URLSearchParams(query)) {
    params.set(key, value);
  }
  params.set(SETTINGS_PARAM, page);
  return `${pathname}?${params.toString()}`;
};

/**
 * A landing redirect (`/org/<id>` and `/org/<id>/workspaces` forwarding to
 * the first agent) carrying an open modal along: `?settings=<page>` on the
 * way in is `?settings=<page>` on the way out, so a deep link to the modal
 * over an org URL still opens it. Only that one param, re-encoded; anything
 * else on an org landing URL meant nothing to the agent page.
 */
export const carrySettingsParam = (
  landing: string,
  searchParams: Record<string, string | string[] | undefined>,
): string => {
  const raw = searchParams[SETTINGS_PARAM];
  const page = Array.isArray(raw) ? raw[0] : raw;
  if (!isSettingsPageId(page)) return landing;
  const query = new URLSearchParams({ [SETTINGS_PARAM]: page });
  return `${landing}?${query.toString()}`;
};
