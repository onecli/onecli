"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid } from "lucide-react";
import { AgentAvatar } from "@/lib/agents/_components/agent-avatar";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@onecli/ui/components/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { AppIcon } from "@/lib/components/app-icon";
import { isSlackConnected, SLACK_ICON_SRC } from "@/lib/agents/slack-presence";
import { sidebarMenuButtonActiveStyles } from "@dashboard/nav-main";
import { defaultAgentSection } from "@/lib/agents/agent-sections";
import { useAgentsForWorkspace } from "@/hooks/use-agents";
import { agentSectionPath, matchAgentPage } from "@/lib/navigation";

/**
 * The sidebar's Agents group (§3.18, as amended 2026-08-16): a "Manage agents"
 * row (the roster page, which used to sit in the main nav) set apart from the
 * workspace's agents listed below it — EVERY agent, hosted and BYO alike, one
 * click from anywhere to its own page (a hosted agent's thread, a BYO agent's
 * connections). The list is availability-independent: these are the user's
 * agents, and hiding them because no runner exists would read as data loss.
 *
 * The Manage agents row is UNCONDITIONAL — it is the former main-nav entry.
 */
export const AgentsGroup = ({ workspaceId }: { workspaceId: string }) => {
  const pathname = usePathname();
  // Explicit workspace scope, NOT the URL-scoped `useAgents()`: the sidebar is
  // chrome and its query can fire while the browser is mid-transition on a
  // non-workspace URL, where a URL-scoped server action has no workspace
  // header and answers 500 (the fresh-install first-open console error).
  const { data: agents = [], isPending } = useAgentsForWorkspace(
    workspaceId,
    true,
  );

  const allAgentsUrl = `/w/${workspaceId}/agents`;

  // Inside an agent that has no row of its own — deleted from the list, or the
  // list still empty on error — the roster row is where the user is standing.
  // Without this, that agent's pages leave ZERO highlighted rows in the whole
  // sidebar. Decided only once the answer is KNOWN: while the agent list is
  // still loading, highlight nothing rather than flash the roster row over an
  // agent's own.
  const inAgent = matchAgentPage(pathname);
  const rowsSettled = !isPending;
  const insideRowlessAgent =
    rowsSettled &&
    inAgent !== null &&
    !agents.some((a) => a.id === inAgent.agentId);
  const rosterActive = pathname === allAgentsUrl || insideRowlessAgent;

  return (
    <SidebarGroup className="min-h-0 flex-1 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-0">
      <SidebarGroupLabel className="group-data-[collapsible=icon]:hidden">
        Agents
      </SidebarGroupLabel>
      <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
        <SidebarMenu className="shrink-0">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              // EXACT on the roster itself, never a prefix — plus the
              // row-less-agent case above. Exactly one row highlights: inside
              // a row-owning agent it is that agent's row, and two
              // brand-active rows would read as two places at once.
              isActive={rosterActive}
              tooltip="Manage Agents"
              className={sidebarMenuButtonActiveStyles}
            >
              <Link
                href={allAgentsUrl}
                aria-current={rosterActive ? "page" : undefined}
              >
                {/* The list of agents is a list, not an agent: the robot is
                    reserved for the agents themselves, one row each. */}
                <LayoutGrid aria-hidden />
                <span>Manage Agents</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {agents.length > 0 && <SidebarSeparator className="my-2" />}
        {/* The one scroll region: only the agent list scrolls, so the nav and
            the Manage agents row stay reachable however many agents exist. A
            native scroller on purpose (never Radix ScrollArea, which needs a
            definite-height viewport). Accepted edge: on a viewport too short
            for even the nav, the group compresses and clips. */}
        <SidebarMenu className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {agents.map((agent) => {
            const href = agentSectionPath(
              pathname,
              agent.id,
              defaultAgentSection(agent.kind),
            );
            // Highlighted anywhere inside THIS agent, not only on its landing
            // section: the row names the agent you are in, and the agent
            // page's own rail says which section.
            const active = inAgent?.agentId === agent.id;
            return (
              <SidebarMenuItem key={agent.id}>
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  tooltip={agent.name}
                  className={sidebarMenuButtonActiveStyles}
                >
                  <Link href={href} aria-current={active ? "page" : undefined}>
                    <AgentAvatar
                      agent={agent}
                      className="size-4 rounded-sm border-0 bg-transparent text-current"
                    />
                    {/* Explicit truncate: the trailing mark can make this span
                        no longer :last-child, which is what the button
                        variant's own truncation targets. */}
                    <span className="truncate">{agent.name}</span>
                    {isSlackConnected(agent.channels) && (
                      // Reachable in Slack — the real mark, small and
                      // trailing. Decorative visual; the label lives in the
                      // tooltip and one sr-only sentence (the
                      // credential-avatars pattern), and icon-collapse hides
                      // it the way SidebarMenuBadge hides itself.
                      <>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              aria-hidden="true"
                              className="ml-auto flex shrink-0 items-center group-data-[collapsible=icon]:hidden"
                            >
                              <AppIcon
                                icon={SLACK_ICON_SRC}
                                name="Slack"
                                size={12}
                              />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Connected to Slack</TooltipContent>
                        </Tooltip>
                        <span className="sr-only">Connected to Slack</span>
                      </>
                    )}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
};
