"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AgentAvatar } from "@/lib/agents/_components/agent-avatar";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@onecli/ui/components/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { AppIcon } from "@/lib/components/app-icon";
import { connectedPresences } from "@/lib/agents/channel-providers";
import { channelProviderUi } from "@/lib/agents/channel-providers/registry";
import { sidebarMenuButtonActiveStyles } from "@dashboard/nav-main";
import { defaultAgentSection } from "@/lib/agents/agent-sections";
import { useAgentsForWorkspace } from "@/hooks/use-agents";
import { sortAgentsOldestFirst } from "@/lib/agents/agent-order";
import { agentSectionPath, matchAgentPage } from "@/lib/navigation";
import { NewAgentRow } from "@/lib/dashboard/new-agent-row";

/**
 * The sidebar's Agents group (§3.18, as amended): the workspace's agents —
 * EVERY agent, hosted and BYO alike, one click from anywhere to its own page
 * (a hosted agent's thread, a BYO agent's connections) — and, under the last
 * one, the "New agent" row. The list is availability-independent: these are
 * the user's agents, and hiding them because no runner exists would read as
 * data loss.
 *
 * There is no "Manage agents" row any more: there is no roster to manage
 * from (everything a card offered lives on the agent's own page), and the
 * only thing left at `/agents` is creation, which the New agent row does
 * in place.
 *
 * The group is the sidebar's FIRST section and lists agents OLDEST first: the
 * top agent is the workspace's front door (`/w/<id>` lands on it — the same
 * `sortAgentsOldestFirst` order the server-side landing uses).
 */
export const AgentsGroup = ({ workspaceId }: { workspaceId: string }) => {
  const pathname = usePathname();
  // Explicit workspace scope, NOT the URL-scoped `useAgents()`: the sidebar is
  // chrome and its query can fire while the browser is mid-transition on a
  // non-workspace URL, where a URL-scoped read carries no workspace and is
  // refused (the fresh-install first-open console error).
  const { data: rawAgents, isPending } = useAgentsForWorkspace(
    workspaceId,
    true,
  );
  const agents = sortAgentsOldestFirst(rawAgents ?? []);

  // Highlighted anywhere inside an agent — exactly one row, the agent you
  // are in. An agent with no row (deleted, or the list errored) highlights
  // nothing; the page's own header still names it.
  const inAgent = matchAgentPage(pathname);

  return (
    // Sized to its content (not flex-1): it sits ABOVE the workspace nav, so
    // growing would shove that nav to the sidebar's bottom. `min-h-0` still
    // lets it shrink so only the agent list scrolls when it is long.
    <SidebarGroup className="min-h-0 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-0">
      <SidebarGroupLabel className="group-data-[collapsible=icon]:hidden">
        Agents
      </SidebarGroupLabel>
      <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
        {/* The one scroll region: only the agent list scrolls, so the New
            agent row and the nav below stay reachable however many agents
            exist. A native scroller on purpose (never Radix ScrollArea, which
            needs a definite-height viewport). */}
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
                    {connectedPresences(agent.channels)
                      .map((presence) => channelProviderUi(presence.provider))
                      .filter((ui) => ui !== null)
                      .map((ui) => (
                        // Reachable on the provider — the real mark, small
                        // and trailing. Decorative visual; the label lives in
                        // the tooltip and one sr-only sentence, and
                        // icon-collapse hides it the way SidebarMenuBadge
                        // hides itself.
                        <span key={ui.id} className="contents">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                aria-hidden="true"
                                className="ml-auto flex shrink-0 items-center group-data-[collapsible=icon]:hidden"
                              >
                                <AppIcon
                                  icon={ui.iconSrc}
                                  name={ui.name}
                                  size={12}
                                />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              Connected to {ui.name}
                            </TooltipContent>
                          </Tooltip>
                          <span className="sr-only">
                            Connected to {ui.name}
                          </span>
                        </span>
                      ))}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
        <SidebarMenu className="shrink-0">
          <NewAgentRow agents={rawAgents} agentsPending={isPending} />
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
};
