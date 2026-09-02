import {
  FolderOpen,
  Users,
  Boxes,
  BarChart3,
  CreditCard,
  Settings,
  Building2,
  Fingerprint,
  Globe,
  KeyRound,
  MessagesSquare,
  ShieldCheck,
  Plug,
  Shield,
  LayoutGrid,
  LayoutDashboard,
  Download,
  Activity,
  Sparkles,
} from "lucide-react";
import type { NavItem } from "@/app/(dashboard)/_components/nav-main";
import { CAPS } from "@/lib/env";
import { AgentIcon } from "@/lib/agents/agent-icon";

export interface SettingsNavItem {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface SettingsNavSection {
  label: string;
  items: SettingsNavItem[];
}

const orgPrefix = (id?: string) => (id ? `/org/${id}` : "");

/**
 * Entitlement input for the sidebar: the baked client bundle cannot know the
 * enterprise entitlement (`CAPS` is build-time), so the caller threads the
 * runtime answer from `useInstance()`. It drives VISIBILITY only — no lock
 * markers: `true`/`false` (the instance answered either way) shows the
 * enterprise entries, which land on the server-gated license page when
 * unlicensed; `null`/`undefined` (still loading on a non-RBAC build) keeps
 * them hidden to avoid a flash.
 */
export interface NavEntitlement {
  entitled?: boolean | null;
}

/**
 * Availability input for the hosted-only nav entries (§3.13 — no runner, no
 * feature). `hosted` DEFAULTS TO TRUE so the breadcrumb resolver — which has
 * no availability read and only maps a URL back to a section title — keeps
 * resolving the hosted-only ORG entries unconditionally (a crumb resolving
 * reveals nothing; the sidebar is what decides visibility, threading the
 * runtime answer from `useHostedAvailability`).
 */
export interface NavAvailability {
  hosted?: boolean;
}

/** Set by the sidebar only: drop the sections the sidebar renders elsewhere
 *  (Agents, which becomes its own group). The breadcrumb resolver leaves it
 *  unset and keeps the full table. */
export interface NavSurface {
  sidebar?: boolean;
}

/**
 * The workspace section table — the sidebar's render list AND the header
 * breadcrumb's section resolver (longest URL prefix). Chat is not here: the
 * agent is the thread (§3.18), so chat lives on the agent page.
 *
 * Agents is not in the sidebar's render list either: the sidebar gives it its
 * own GROUP (`AgentsGroup`), whose "Manage agents" row is this section and
 * whose remaining rows are the workspace's agents. It stays in the TABLE
 * because the header breadcrumb resolves section titles from here —
 * `opts.sidebar` is what drops it from the sidebar's copy, so the crumb keeps
 * reading "Agents".
 */
export const workspaceNavItems = (
  workspaceId: string,
  opts?: NavSurface,
): NavItem[] => [
  {
    title: "Overview",
    url: `/w/${workspaceId}/overview`,
    icon: LayoutDashboard,
  },
  ...(opts?.sidebar
    ? []
    : [{ title: "Agents", url: `/w/${workspaceId}/agents`, icon: AgentIcon }]),
  { title: "Connections", url: `/w/${workspaceId}/connections`, icon: Plug },
  // No workspace-level Skills entry: skills describe how one AGENT works, so
  // they live in that agent's section (§3.18 as amended). The org tier keeps
  // its own page — it is a different promise (every agent, everywhere).
  { title: "Activity", url: `/w/${workspaceId}/activity`, icon: Activity },
  {
    title: "Workspace Settings",
    url: `/w/${workspaceId}/settings`,
    icon: Settings,
  },
];

export const getNavItems = (
  orgId?: string,
  opts?: NavEntitlement & NavAvailability,
): NavItem[][] => {
  const p = orgPrefix(orgId);
  const entitlementKnown = opts?.entitled === true || opts?.entitled === false;
  // Members (#65) is free on every deployment. Groups is enterprise: shown on
  // RBAC builds (cloud) and once the runtime entitlement is known either way.
  // App Availability is org administration and lives under Organization
  // Settings (`getSettingsSections`), beside the other org-wide controls.
  // Usage + Billing need billing.
  const adminGroup: NavItem[] = [
    // "Members" (not "Team"/"Users"): for humans OneCLI is the SP — the label
    // matches the /v1/org/members API resource. The /team URL is historical,
    // not a label.
    { title: "Members", url: `${p}/team`, icon: Users },
  ];
  if (CAPS.rbac || entitlementKnown) {
    adminGroup.push({ title: "Groups", url: `${p}/groups`, icon: Boxes });
  }
  if (CAPS.billing) {
    adminGroup.push({ title: "Usage", url: `${p}/usage`, icon: BarChart3 });
    adminGroup.push({
      title: "Billing",
      url: `${p}/billing`,
      icon: CreditCard,
    });
  }
  adminGroup.push({
    title: "Organization Settings",
    url: `${p}/settings/general`,
    icon: Settings,
  });
  return [
    [
      { title: "Workspaces", url: `${p}/workspaces`, icon: FolderOpen },
      {
        title: "Global Connections",
        url: `${p}/global-connections`,
        icon: Plug,
      },
      { title: "Global Policy", url: `${p}/policy`, icon: Shield },
      // Both hosted-only (§3.13 — no runner, no surface): Channels is where
      // hosted agents meet the team (§3.16), an org-wide integration surface
      // beside Global Connections rather than a settings pane; org-tier
      // skills reach every workspace's hosted agents.
      ...(opts?.hosted !== false
        ? [
            {
              title: "Channels",
              url: `${p}/channels`,
              icon: MessagesSquare,
            },
            { title: "Skills", url: `${p}/skills`, icon: Sparkles },
          ]
        : []),
    ],
    adminGroup,
  ];
};

/**
 * The workspace-settings sub-nav (the pane beside `/w/<id>/settings/*`), the
 * same shape the org settings area uses. Install lives here rather than in the
 * main sidebar: setting a machine up is a one-time workspace configuration
 * step, not a place you return to, so it sits beside rename/access/delete.
 */
export const getWorkspaceSettingsSections = (
  workspaceId: string,
): SettingsNavSection[] => [
  {
    label: "Workspace",
    items: [
      {
        title: "General",
        url: `/w/${workspaceId}/settings/general`,
        icon: Settings,
      },
      {
        title: "Install",
        url: `/w/${workspaceId}/settings/install`,
        icon: Download,
      },
    ],
  },
];

export const getSettingsSections = (orgId?: string): SettingsNavSection[] => {
  const p = orgPrefix(orgId);
  return [
    {
      label: "Organization",
      items: [
        { title: "General", url: `${p}/settings/general`, icon: Building2 },
        { title: "Domains", url: `${p}/settings/domains`, icon: Globe },
        {
          title: "Single sign-on",
          url: `${p}/settings/sso`,
          icon: Fingerprint,
        },
        // Enterprise, like Single sign-on above: listed unconditionally and
        // gated by the page itself, which renders the licensed card when the
        // deployment is not entitled.
        {
          title: "App Availability",
          url: `${p}/settings/app-availability`,
          icon: LayoutGrid,
        },
        {
          title: "API Keys",
          url: `${p}/settings/org-api-keys`,
          icon: KeyRound,
        },
        {
          title: "Encryption",
          url: `${p}/settings/encryption`,
          icon: ShieldCheck,
        },
      ],
    },
  ];
};
