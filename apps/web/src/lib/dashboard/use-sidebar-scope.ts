"use client";

import { usePathname } from "next/navigation";
import { getNavItems, workspaceNavItems } from "@/lib/nav-config";
import { useInstance } from "@/hooks/use-instance";
import { useOrgMembership } from "@/hooks/use-org";
import { useWorkspaceOrgId } from "@/lib/dashboard/use-workspace-org-id";
import { extractOrgId } from "@/lib/org-navigation";
import {
  isOrgScopedPath,
  orgHomePath,
  WORKSPACE_PATH_RE,
} from "@/lib/navigation";
import { showsHostedSurface } from "@/lib/agents/availability";
import { useHostedAvailability } from "@/hooks/use-hosted-availability";
import type { NavItem } from "@dashboard/nav-main";
import type { SettingsPageId } from "@/lib/settings-modal/pages";
import { useSettingsHref } from "@/lib/settings-modal/use-settings-href";

// Members see only their workspaces in the org nav. Every other org-level screen
// (global connections/rules, team, usage, billing, organization settings) is
// admin/owner-only. This is an allowlist, not a denylist: any org nav item added
// later is hidden from members by default until it's listed here — fail closed.
// Layer 1 of defense-in-depth, alongside the (admin) route-group guard (Layer 2)
// and the admin-gated server actions + /v1/org/* APIs (Layer 3).
const MEMBER_ORG_NAV_PATHS = ["/workspaces"];

/** The modal page an org or workspace nav URL opens (plans/flatten-ui.md,
 *  route map), by the URL's last segments; null for rows that stay full
 *  pages. */
const modalPageFor = (url: string): SettingsPageId | null => {
  if (/\/settings(\/general)?$/.test(url)) {
    return /^\/w\//.test(url) ? "workspace" : "general";
  }
  if (/\/team$/.test(url)) return "members";
  if (/\/groups$/.test(url)) return "security";
  if (/\/billing$/.test(url)) return "billing";
  if (/\/channels$/.test(url)) return "slack";
  if (/^\/w\/[^/]+\/connections$/.test(url)) return "apps";
  if (/^\/w\/[^/]+\/activity$/.test(url)) return "activity";
  return null;
};

interface SidebarScope {
  /** `/w/<id>` URLs. */
  workspaceId: string | undefined;
  /** `/org/<id>` URLs, or the org a workspace URL announced. */
  orgId: string | null;
  /** The org's workspaces list, or `/` while no org is known. */
  workspacesUrl: string;
  /** The nav rows for this URL scope, in order: the workspace's or the
   *  org's (members see the allowlisted subset); settings entries point at
   *  the modal. */
  navItems: NavItem[];
}

/**
 * Everything the sidebar needs to know about the URL it sits beside.
 */
export const useSidebarScope = (): SidebarScope => {
  const pathname = usePathname();
  const workspaceId = pathname.match(WORKSPACE_PATH_RE)?.[1];
  const orgId = extractOrgId(pathname);
  const workspaceOrgId = useWorkspaceOrgId();
  // The cached membership read the top bar and the account menu share.
  // Until it answers the viewer counts as a member: the admin rows appear
  // once it says so, never the other way round (fail closed). Not asked on
  // the account's own page, which names no org to ask about.
  const { data: membership } = useOrgMembership(isOrgScopedPath(pathname));
  const isAdmin = membership?.isAdmin === true;

  const effectiveOrgId = orgId ?? workspaceOrgId;
  const instance = useInstance();
  // §3.13: the hosted-only entries (Channels, Skills) hide on runnerless or
  // BYO-only deployments.
  const hosted = showsHostedSurface(useHostedAvailability());
  // No org known (an `/account/*` URL before its redirect lands, or a
  // workspace URL before the page announces its org): no org nav. The rows
  // `getNavItems(undefined)` would build point at `/workspaces`, `/skills`
  // and the like, which are not routes; the sidebar would render them and
  // the router would prefetch 404s for every one.
  const orgNavItems = effectiveOrgId
    ? getNavItems(effectiveOrgId, {
        entitled: instance && instance.entitled,
        hosted,
      })
    : [];
  const filteredOrgItems = isAdmin
    ? orgNavItems.flat()
    : orgNavItems
        .flat()
        .filter((item) =>
          MEMBER_ORG_NAV_PATHS.some((p) => item.url.endsWith(p)),
        );

  const workspacesUrl = effectiveOrgId ? orgHomePath(effectiveOrgId) : "/";

  // The gear opens the Settings modal over the current page; the rows that
  // have a modal page open it too.
  const settingsHref = useSettingsHref();
  const toModal = (item: NavItem): NavItem => {
    const page = modalPageFor(item.url);
    return page ? { ...item, url: settingsHref(page) } : item;
  };

  const items = workspaceId ? workspaceNavItems(workspaceId) : filteredOrgItems;
  const navItems = items.map(toModal);

  return {
    workspaceId,
    orgId: effectiveOrgId,
    workspacesUrl,
    navItems,
  };
};
