import {
  FolderOpen,
  Users,
  Boxes,
  CreditCard,
  Settings,
  MessagesSquare,
  Plug,
  Activity,
  Sparkles,
} from "lucide-react";
import type { NavItem } from "@/app/(dashboard)/_components/nav-main";
import { CAPS } from "@/lib/env";
import { orgPath, workspacePath, type OrgPage } from "@/lib/navigation";

/**
 * Entitlement input for the sidebar: the baked client bundle cannot know the
 * enterprise entitlement (`CAPS` is build-time), so the caller threads the
 * runtime answer from `useInstance()`. It drives VISIBILITY only — no lock
 * markers: `true`/`false` (the instance answered either way) shows the
 * enterprise entries, which open the license card when unlicensed;
 * `null`/`undefined` (still loading on a non-RBAC build) keeps them hidden
 * to avoid a flash.
 */
export interface NavEntitlement {
  entitled?: boolean | null;
}

/**
 * Availability input for the hosted-only nav entries (§3.13 — no runner, no
 * feature): `hosted: false` hides them. The sidebar threads the runtime
 * answer from `useHostedAvailability`.
 */
export interface NavAvailability {
  hosted?: boolean;
}

/**
 * The sidebar's rows on a workspace page that is not an agent's (the empty
 * workspace's agents page, a file's download page). Chat is not here: the
 * agent is the thread (§3.18). No Skills either: skills describe how one
 * AGENT works, so they live in that agent's section (§3.18 as amended).
 */
export const workspaceNavItems = (workspaceId: string): NavItem[] => [
  {
    title: "Connections",
    url: workspacePath(workspaceId, "connections"),
    icon: Plug,
  },
  {
    title: "Activity",
    url: workspacePath(workspaceId, "activity"),
    icon: Activity,
  },
  {
    title: "Workspace Settings",
    url: workspacePath(workspaceId, "settings"),
    icon: Settings,
  },
];

/** The org-level nav rows. The caller knows the org: with no id there is
 *  no org nav (`useSidebarScope`), never rows pointing at bare `/<page>`
 *  paths that are not routes. */
export const getNavItems = (
  orgId: string,
  opts?: NavEntitlement & NavAvailability,
): NavItem[][] => {
  const p = (page: OrgPage) => orgPath(orgId, page);
  const entitlementKnown = opts?.entitled === true || opts?.entitled === false;
  // Members (#65) is free on every deployment. Groups is enterprise: shown on
  // RBAC builds (cloud) and once the runtime entitlement is known either way.
  // The rest of org administration (shared apps, rules, app availability)
  // lives in the Settings modal beside Organization Settings. Billing (the
  // modal's "Billing & usage") needs billing.
  const adminGroup: NavItem[] = [
    // "Members" (not "Team"/"Users"): for humans OneCLI is the SP — the label
    // matches the /v1/org/members API resource. The /team URL is historical,
    // not a label.
    { title: "Members", url: p("team"), icon: Users },
  ];
  if (CAPS.rbac || entitlementKnown) {
    adminGroup.push({ title: "Groups", url: p("groups"), icon: Boxes });
  }
  if (CAPS.billing) {
    adminGroup.push({
      title: "Billing",
      url: p("billing"),
      icon: CreditCard,
    });
  }
  adminGroup.push({
    title: "Organization Settings",
    url: p("settings/general"),
    icon: Settings,
  });
  return [
    [
      { title: "Workspaces", url: p("workspaces"), icon: FolderOpen },
      // Both hosted-only (§3.13 — no runner, no surface): Channels is where
      // hosted agents meet the team (§3.16), an org-wide integration surface
      // rather than a settings pane; org-tier skills reach every workspace's
      // hosted agents.
      ...(opts?.hosted !== false
        ? [
            {
              title: "Channels",
              url: p("channels"),
              icon: MessagesSquare,
            },
            { title: "Skills", url: p("skills"), icon: Sparkles },
          ]
        : []),
    ],
    adminGroup,
  ];
};
