"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { NavMain } from "@dashboard/nav-main";
import { NavUser } from "@/lib/dashboard/nav-user";
import { SidebarVersion } from "@/lib/dashboard/sidebar-version";
import { OrgSwitcher } from "@/lib/dashboard/org-switcher";
import { AgentsGroup } from "@/lib/dashboard/agents-group";
import { getNavItems, workspaceNavItems } from "@/lib/nav-config";
import { useInstance } from "@/hooks/use-instance";
import { extractOrgId } from "@/lib/org-navigation";
import { accountNavItems } from "@/lib/account/account-nav-items";
import { getUserOrgRole } from "@/ee/team/actions";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@onecli/ui/components/sidebar";
import { WORKSPACE_PATH_RE } from "@/lib/navigation";
import { CAPS } from "@/lib/env";
import { showsHostedSurface } from "@/lib/agents/availability";
import { useHostedAvailability } from "@/hooks/use-hosted-availability";
import type { OrgRole } from "@onecli/api/ee/services/authorization-service";
import { SidebarQuota } from "@/ee/billing/_components/sidebar-quota";

// Members see only their workspaces in the org nav. Every other org-level screen
// (global connections/rules, team, usage, billing, organization settings) is
// admin/owner-only. This is an allowlist, not a denylist: any org nav item added
// later is hidden from members by default until it's listed here — fail closed.
// Layer 1 of defense-in-depth, alongside the (admin) route-group guard (Layer 2)
// and the admin-gated server actions + /v1/org/* APIs (Layer 3).
const MEMBER_ORG_NAV_PATHS = ["/workspaces"];

export const DashboardSidebar = ({
  ...props
}: React.ComponentProps<typeof Sidebar>) => {
  const pathname = usePathname();
  const workspaceMatch = pathname.match(WORKSPACE_PATH_RE);
  const workspaceId = workspaceMatch?.[1];
  const orgId = extractOrgId(pathname);
  const isAccount = pathname.startsWith("/account");
  const [role, setRole] = React.useState<OrgRole>("member");
  const [workspaceOrgId, setWorkspaceOrgId] = React.useState<string | null>(
    null,
  );

  React.useEffect(() => {
    getUserOrgRole()
      .then(setRole)
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    const onContext = (e: Event) => {
      const detail = (e as CustomEvent<{ organizationId?: string }>).detail;
      if (detail.organizationId) setWorkspaceOrgId(detail.organizationId);
    };
    window.addEventListener("onecli:workspace-context", onContext);
    return () =>
      window.removeEventListener("onecli:workspace-context", onContext);
  }, []);

  const effectiveOrgId = orgId ?? workspaceOrgId;
  const instance = useInstance();
  // §3.13: the hosted-only entries (Skills) hide on runnerless/BYO-only
  // deployments. The breadcrumb resolver keeps its availability-blind default
  // — visibility is decided HERE, once, for both nav levels.
  const hosted = showsHostedSurface(useHostedAvailability());
  const orgNavItems = getNavItems(effectiveOrgId ?? undefined, {
    entitled: instance && instance.entitled,
    hosted,
  });
  const filteredOrgItems =
    role === "member"
      ? orgNavItems
          .map((group) =>
            group.filter((item) =>
              MEMBER_ORG_NAV_PATHS.some((p) => item.url.endsWith(p)),
            ),
          )
          .filter((group) => group.length > 0)
      : orgNavItems;

  const workspacesUrl = effectiveOrgId
    ? `/org/${effectiveOrgId}/workspaces`
    : "/";

  const items = workspaceId
    ? workspaceNavItems(workspaceId, { sidebar: true })
    : isAccount
      ? accountNavItems
      : filteredOrgItems;

  return (
    <Sidebar collapsible="icon" variant="inset" {...props}>
      <SidebarHeader className="h-12 justify-center group-data-[collapsible=icon]:px-0">
        <div className="flex items-center justify-between px-2">
          <Link href={workspacesUrl} className="flex items-center">
            <Image
              src="/onecli-full-logo.png"
              alt="OneCLI"
              width={80}
              height={23}
              priority
              className="group-data-[collapsible=icon]:hidden dark:hidden"
            />
            <Image
              src="/onecli-full-logo-dark.png"
              alt="OneCLI"
              width={80}
              height={23}
              priority
              className="hidden dark:group-data-[collapsible=icon]:!hidden dark:block"
            />
            <Image
              src="/logo-icon.svg"
              alt="OneCLI"
              width={20}
              height={20}
              className="hidden group-data-[collapsible=icon]:block"
            />
          </Link>
          <div className="group-data-[collapsible=icon]:hidden">
            <OrgSwitcher />
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {(workspaceId || isAccount) && (
          <SidebarMenu className="px-2 pt-2 group-data-[collapsible=icon]:hidden">
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                size="sm"
                className="text-muted-foreground hover:text-foreground"
              >
                <Link href={workspacesUrl}>
                  <ChevronLeft className="size-3.5" />
                  {isAccount ? "Back to dashboard" : "All workspaces"}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
        <NavMain items={items} />
        {workspaceId && <AgentsGroup workspaceId={workspaceId} />}
      </SidebarContent>
      <SidebarFooter
        className="justify-center group-data-[collapsible=icon]:px-0"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
      >
        {CAPS.billing && (
          <div className="group-data-[collapsible=icon]:hidden">
            <SidebarQuota />
          </div>
        )}
        <NavUser />
        <SidebarVersion />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
};
