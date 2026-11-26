"use client";

import { usePathname } from "next/navigation";
import { matchAgentPage } from "@/lib/navigation";
import { isTheaterAgentSection } from "@/lib/agents/agent-sections";
import {
  isAccountPath,
  isRedirectOnlyPath,
} from "@/lib/dashboard/redirect-only-routes";
import { AgentSectionCell } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/_components/agent-section-cell";
import { AgentSectionSkeleton } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/_components/agent-section-skeleton";
import { AgentNavSkeleton } from "./agent-nav-skeleton";
import { DashboardShellSkeleton } from "./dashboard-shell-skeleton";
import { PendingLanding } from "./pending-landing";
import { THEATER_FRAME } from "./shell-geometry";

/**
 * The dashboard while it gets ready to draw (sign-in resolving, the session
 * check, the home page working out where to land): the shell's skeleton,
 * shaped by the URL being opened, so a first load reads as one page filling
 * in, never a spinner, a blank shell and then a different skeleton.
 *
 * - An agent URL: the agent's sidebar, and that section's own skeleton in
 *   the section's own cell, the same picture its route and frame draw next.
 * - The home page, an old address that only forwards, and the account's
 *   addresses (which forward too, for anyone with an org; the session
 *   tells later): `PendingLanding`, as their new page is not known until
 *   the server answers.
 * - The theater: its dark frame, the way the page itself has no chrome.
 * - Anything else (an org page): the generic shell.
 */
export const PendingDashboard = () => {
  const pathname = usePathname();
  if (
    pathname === "/" ||
    isRedirectOnlyPath(pathname) ||
    isAccountPath(pathname)
  ) {
    return <PendingLanding />;
  }
  const agentPage = matchAgentPage(pathname);
  if (!agentPage) return <DashboardShellSkeleton />;
  const { section } = agentPage;
  const content = (
    <AgentSectionCell section={section}>
      <AgentSectionSkeleton section={section} />
    </AgentSectionCell>
  );
  return isTheaterAgentSection(section) ? (
    <div className={THEATER_FRAME}>{content}</div>
  ) : (
    <DashboardShellSkeleton sidebar={<AgentNavSkeleton />} body={content} />
  );
};
