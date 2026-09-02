"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import {
  BookOpen,
  Moon,
  Sun,
  FolderOpen,
  Users,
  Boxes,
  BarChart3,
  CreditCard,
  Settings,
  Rocket,
  MessagesSquare,
} from "lucide-react";
import Link from "next/link";
import { SidebarTrigger } from "@onecli/ui/components/sidebar";
import { Separator } from "@onecli/ui/components/separator";
import { Button } from "@onecli/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@onecli/ui/components/breadcrumb";
import type { NavItem } from "@dashboard/nav-main";
// The FULL section table, hidden sections included: this resolves the
// breadcrumb title for whatever url the user is ON, so it must know Chat
// even where the sidebar hides it.
import { workspaceNavItems } from "@/lib/nav-config";
import { GetStartedButton } from "@dashboard/get-started-button";
import { AgentCrumb } from "@/lib/dashboard/agent-crumb";
import { agentSectionTitle } from "@/lib/agents/agent-sections";
import { ApprovalsBell } from "@/lib/components/approvals";
import { matchAgentPage, WORKSPACE_PATH_RE } from "@/lib/navigation";
import { CAPS } from "@/lib/env";
import { extractOrgId } from "@/lib/org-navigation";
import { accountNavItems } from "@/lib/account/account-nav-items";
import { GitHubIcon } from "./github-icon";
import { DiscordIcon } from "./discord-icon";
import { PlanBadge } from "@/ee/billing/_components/plan-badge";
import { usePlanUsage } from "@/ee/billing/use-plan-usage";
import { Skeleton } from "@onecli/ui/components/skeleton";

const getOrgNavItems = (orgId?: string): NavItem[] => {
  const p = orgId ? `/org/${orgId}` : "";
  return [
    { title: "All workspaces", url: `${p}/workspaces`, icon: FolderOpen },
    { title: "Members", url: `${p}/team`, icon: Users },
    { title: "Groups", url: `${p}/groups`, icon: Boxes },
    { title: "Channels", url: `${p}/channels`, icon: MessagesSquare },
    { title: "Usage", url: `${p}/usage`, icon: BarChart3 },
    { title: "Billing", url: `${p}/billing`, icon: CreditCard },
    { title: "Organization Settings", url: `${p}/settings`, icon: Settings },
    { title: "Deploy", url: `${p}/deploy`, icon: Rocket },
  ];
};

const formatSegment = (s: string) =>
  s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " ");

/**
 * The dashboard header for every edition, reached through the
 * `@dashboard/dashboard-header` re-export shim. Renders a workspace-aware
 * breadcrumb when the URL is under `/w/[workspaceId]/...`:
 *
 *     All workspaces / <Workspace Name> / Overview / sub
 *
 * Outside a workspace (`/org/<id>/workspaces`, settings, etc.) it falls back to
 * plain segment breadcrumbs.
 */
export const DashboardHeader = () => {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const workspaceMatch = pathname.match(WORKSPACE_PATH_RE);
  const workspaceId = workspaceMatch?.[1] ?? null;
  const orgId = extractOrgId(pathname);
  const planUsage = usePlanUsage();
  const orgName = planUsage?.organizationName ?? null;
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [workspaceOrgId, setWorkspaceOrgId] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setWorkspaceName(null);
      setWorkspaceOrgId(null);
      return;
    }

    const onContext = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          workspaceId: string;
          name: string | null;
          organizationId?: string;
        }>
      ).detail;
      if (detail.workspaceId === workspaceId) {
        if (detail.name) setWorkspaceName(detail.name);
        if (detail.organizationId) setWorkspaceOrgId(detail.organizationId);
      }
    };
    window.addEventListener("onecli:workspace-context", onContext);

    return () => {
      window.removeEventListener("onecli:workspace-context", onContext);
    };
  }, [workspaceId]);

  const effectiveOrgId = orgId ?? workspaceOrgId;
  const isAccount = pathname.startsWith("/account");
  const items = workspaceId
    ? workspaceNavItems(workspaceId)
    : isAccount
      ? accountNavItems
      : getOrgNavItems(effectiveOrgId ?? undefined);
  // Longest URL prefix wins so /workspaces/api-keys beats /workspaces.
  const navItem = items
    .filter((item) => pathname.startsWith(item.url))
    .sort((a, b) => b.url.length - a.url.length)[0];
  const sectionTitle = navItem?.title ?? null;

  const subPath = navItem
    ? pathname.slice(navItem.url.length).replace(/^\//, "")
    : "";
  // The agent page gets a real crumb where its opaque id would be: the
  // agent's NAME as a switcher dropdown (§3.18 — switch agents, hold the
  // section).
  const agentCrumbId = matchAgentPage(pathname)?.agentId ?? null;
  // Opaque resource ids (uuid detail segments, e.g. /agents/<id>) would
  // title-case into gibberish — drop them; the page's own header names the
  // resource. The digit requirement keeps long PROVIDER slugs (all letters)
  // rendering as crumbs. Mirrors the OSS dashboard-header. The agent id is
  // dropped explicitly — `AgentCrumb` takes its place.
  const subSegments = (subPath ? subPath.split("/") : []).filter(
    (s) => s !== agentCrumbId && !(/^[a-z0-9-]{16,}$/i.test(s) && /\d/.test(s)),
  );
  const workspaceLabel = workspaceName ?? "Workspace";

  return (
    <div className="flex w-full items-center gap-2 px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4!" />
      <Breadcrumb className="min-w-0 flex-1 overflow-hidden">
        <BreadcrumbList className="flex-nowrap overflow-hidden">
          {!isAccount && CAPS.billing && (
            <>
              <BreadcrumbItem className="hidden min-w-0 md:flex md:items-center md:gap-1.5">
                {orgName ? (
                  <>
                    <BreadcrumbLink asChild>
                      <Link
                        href={`${effectiveOrgId ? `/org/${effectiveOrgId}` : ""}/workspaces`}
                        title={orgName}
                        className="min-w-0 truncate text-muted-foreground text-sm hover:text-foreground"
                      >
                        {orgName}
                      </Link>
                    </BreadcrumbLink>
                    <span className="shrink-0">
                      <PlanBadge />
                    </span>
                  </>
                ) : (
                  <>
                    <Skeleton className="h-4 w-24 rounded bg-muted-foreground/10" />
                    <Skeleton className="h-5 w-12 shrink-0 rounded-full bg-muted-foreground/10" />
                  </>
                )}
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden shrink-0 md:block" />
            </>
          )}
          {workspaceId && (
            <>
              <BreadcrumbItem className="hidden shrink-0 whitespace-nowrap md:block">
                <BreadcrumbLink asChild>
                  <Link
                    href={
                      effectiveOrgId ? `/org/${effectiveOrgId}/workspaces` : "/"
                    }
                  >
                    All workspaces
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden shrink-0 md:block" />
              <BreadcrumbItem className="hidden min-w-0 truncate sm:block">
                {sectionTitle ? (
                  <BreadcrumbLink asChild>
                    <Link
                      href={`/w/${workspaceId}/overview`}
                      title={workspaceLabel}
                    >
                      {workspaceLabel}
                    </Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage title={workspaceLabel}>
                    {workspaceLabel}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </>
          )}
          {isAccount && (
            <>
              <BreadcrumbItem className="whitespace-nowrap">
                {sectionTitle ? (
                  <BreadcrumbLink asChild>
                    <Link href="/account/preferences">Account</Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>Account</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </>
          )}
          {sectionTitle && (
            <>
              {(workspaceId || isAccount) && (
                <BreadcrumbSeparator
                  className={
                    workspaceId ? "hidden shrink-0 sm:block" : "shrink-0"
                  }
                />
              )}
              {subSegments.length > 0 || agentCrumbId ? (
                <BreadcrumbItem className="whitespace-nowrap">
                  <BreadcrumbLink asChild>
                    <Link href={navItem!.url}>{sectionTitle}</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
              ) : (
                <BreadcrumbItem className="whitespace-nowrap">
                  <BreadcrumbPage>{sectionTitle}</BreadcrumbPage>
                </BreadcrumbItem>
              )}
              {agentCrumbId && (
                <>
                  <BreadcrumbSeparator className="shrink-0" />
                  <BreadcrumbItem className="min-w-0 whitespace-nowrap">
                    <AgentCrumb agentId={agentCrumbId} />
                  </BreadcrumbItem>
                </>
              )}
              {subSegments.map((segment, i) => {
                const isLast = i === subSegments.length - 1;
                const href =
                  navItem!.url + "/" + subSegments.slice(0, i + 1).join("/");
                // Inside an agent page the segment is a SECTION: its label is
                // the section table's word ("Slack"), never the title-cased
                // URL ("Channels" — the drift the table exists to prevent).
                const label =
                  (agentCrumbId ? agentSectionTitle(segment) : undefined) ??
                  formatSegment(segment);
                return (
                  <span key={segment} className="contents">
                    <BreadcrumbSeparator className="shrink-0" />
                    <BreadcrumbItem className="min-w-0 whitespace-nowrap">
                      {isLast ? (
                        <BreadcrumbPage
                          title={label}
                          className="min-w-0 truncate"
                        >
                          {label}
                        </BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink asChild>
                          <Link href={href}>{label}</Link>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </span>
                );
              })}
            </>
          )}
          {!workspaceId && !sectionTitle && (
            <BreadcrumbItem className="whitespace-nowrap">
              <BreadcrumbPage>
                {isAccount ? "Account" : "Dashboard"}
              </BreadcrumbPage>
            </BreadcrumbItem>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="hidden size-8 md:inline-flex"
              asChild
            >
              <a
                href="https://onecli.sh/docs"
                target="_blank"
                rel="noopener noreferrer"
              >
                <BookOpen className="size-4" />
                <span className="sr-only">Documentation</span>
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Docs</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="hidden size-8 md:inline-flex"
              asChild
            >
              <a
                href="https://github.com/onecli/onecli"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GitHubIcon className="size-4" />
                <span className="sr-only">GitHub</span>
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>GitHub</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="hidden size-8 md:inline-flex"
              asChild
            >
              <a
                href="https://discord.gg/PSztzsQB3g"
                target="_blank"
                rel="noopener noreferrer"
              >
                <DiscordIcon className="size-4" />
                <span className="sr-only">Discord</span>
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Discord</TooltipContent>
        </Tooltip>
        {workspaceId && (
          <>
            <Separator
              orientation="vertical"
              className="mx-1 hidden h-4! md:block"
            />
            <ApprovalsBell />
          </>
        )}
        <Separator
          orientation="vertical"
          className="mx-1 hidden h-4! md:block"
        />
        <span className={subSegments.length > 0 ? "hidden md:contents" : ""}>
          <GetStartedButton />
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
              <span className="sr-only">Toggle theme</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle theme</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};
