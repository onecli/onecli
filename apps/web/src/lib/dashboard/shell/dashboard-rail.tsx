"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import { useAgentsForWorkspace, useWarmAgent } from "@/hooks/use-agents";
import {
  sortAgentsOldestFirst,
  workspaceLandingPath,
} from "@/lib/agents/agent-order";
import { defaultAgentSection } from "@/lib/agents/agent-sections";
import {
  agentPagePath,
  isOrgScopedPath,
  matchAgentPage,
  workspacePath,
} from "@/lib/navigation";
import { useSettingsHref } from "@/lib/settings-modal/use-settings-href";
import { AgentSquare } from "./agent-square-mark";
import { NewAgentSquare } from "./new-agent-square";
import { RailAgentSkeleton } from "./rail-agent-skeleton";
import { RailItem } from "./rail-item";
import { RailLogoMark } from "./rail-logo-mark";
import { RailUserMenu } from "./rail-user-menu";
import { RAIL_AGENT_IDLE, SHELL_RAIL, SHELL_RAIL_LIST } from "./shell-geometry";

/**
 * The rail: the logo, one square per agent (oldest first, the same order
 * the workspace lands on), the New agent square, then the gear and the
 * account menu at the bottom. Agents are the workspace's; outside a
 * workspace URL the rail shows only the fixed squares. Hovering or
 * focusing a hosted agent's square warms its machine, like the Chat
 * button, so the box is up by the time the page is. The logo goes to the
 * workspace's first agent directly (the page its front door forwards to),
 * read off the list the rail already holds.
 */
export const DashboardRail = ({
  workspaceId,
  orgHref,
}: {
  workspaceId: string | null;
  /** Where the logo goes outside a workspace: the org's home. */
  orgHref: string;
}) => {
  const pathname = usePathname();
  const settingsHref = useSettingsHref();
  const warm = useWarmAgent();
  const { data: rawAgents, isPending } = useAgentsForWorkspace(
    workspaceId ?? "",
    workspaceId !== null,
  );
  const agents = sortAgentsOldestFirst(rawAgents ?? []);
  const inAgent = matchAgentPage(pathname);
  const homeHref = workspaceId
    ? rawAgents
      ? workspaceLandingPath(workspaceId, agents[0] ?? null)
      : workspacePath(workspaceId)
    : orgHref;

  return (
    <nav aria-label="Agents" data-slot="dashboard-rail" className={SHELL_RAIL}>
      <Link
        href={homeHref}
        aria-label="OneCLI"
        className="focus-visible:ring-ring mb-1 flex size-9 items-center justify-center rounded-lg outline-none focus-visible:ring-2"
      >
        <RailLogoMark />
      </Link>
      <div className={SHELL_RAIL_LIST}>
        {/* The squares hold their places while the list loads, so the
            agents fill in rather than push the rail's other entries. */}
        {workspaceId && isPending && <RailAgentSkeleton />}
        {workspaceId &&
          agents.map((agent) => {
            const active = inAgent?.agentId === agent.id;
            return (
              <RailItem
                key={agent.id}
                label={agent.name}
                active={active}
                onApproach={() => warm(agent)}
                href={agentPagePath(
                  workspaceId,
                  agent.id,
                  defaultAgentSection(agent.kind),
                )}
                className={cn(
                  "rounded-full",
                  active
                    ? "ring-brand ring-offset-canvas bg-transparent ring-2 ring-offset-2"
                    : RAIL_AGENT_IDLE,
                )}
              >
                <AgentSquare agent={agent} className="rounded-full" />
              </RailItem>
            );
          })}
      </div>
      {/* Below the list, not in it, so it never scrolls out of reach. */}
      {workspaceId && <NewAgentSquare workspaceId={workspaceId} />}
      <div className="flex-1" />
      {/* Settings opens over a page that names an org. The account's own
          page (shown in the shell only to a viewer with no org) has none
          to open it over.

          The two account buttons sit on the same lines as the sidebar's
          Organization block beside them. Both columns end at the window's
          bottom: the org name is centred 40px above it (a 72px box, 9px of
          bottom padding, the name centred in the rest) and the
          ORGANIZATION label 84px above it. With the rail's 12px padding,
          10px under the 36px account button centres it at 40, and a 10px
          gap centres the 32px Settings button at 84. Outlined, so they read
          as buttons on the rail's flat background. */}
      <div className="flex flex-col items-center gap-2.5 pb-2.5">
        {isOrgScopedPath(pathname) && (
          <RailItem
            label="Settings"
            href={settingsHref(workspaceId ? "apps" : "general")}
            className="bg-background/60 border-border/80 size-8 rounded-full border shadow-xs"
          >
            <Settings className="size-4" aria-hidden />
          </RailItem>
        )}
        <RailUserMenu />
      </div>
    </nav>
  );
};
