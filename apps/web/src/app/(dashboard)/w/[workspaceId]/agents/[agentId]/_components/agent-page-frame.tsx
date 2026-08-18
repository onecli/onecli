"use client";

import { createContext, useContext } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AgentIcon } from "@/lib/agents/agent-icon";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { matchAgentPage, withWorkspacePrefix } from "@/lib/navigation";
import {
  agentSectionBlocked,
  isFullHeightAgentSection,
} from "@/lib/agents/agent-sections";
import { useAgents } from "@/hooks/use-agents";
import { AgentPageHeader } from "./agent-page-header";
import { AgentSectionRail } from "./agent-section-rail";
import { EmptyState } from "./empty-state";
import { SectionShell } from "./section-shell";

/**
 * The agent row the list query actually yields — derived from the hook rather
 * than restated, so it cannot drift from it (the rows come from a server
 * action, so dates are `Date`s and `kind` is Prisma's `string`).
 */
export type AgentPageAgent = NonNullable<
  ReturnType<typeof useAgents>["data"]
>[number];

const AgentPageContext = createContext<AgentPageAgent | null>(null);

/**
 * The agent this page is about. Safe to call from any section: the frame
 * resolves the agent and renders the loading, error and not-found states
 * itself, so a section only ever mounts once the agent exists.
 */
export const useAgentPageAgent = (): AgentPageAgent => {
  const agent = useContext(AgentPageContext);
  if (!agent) {
    throw new Error("useAgentPageAgent must be used inside the agent page");
  }
  return agent;
};

/** Same context, absence-tolerant: for components that can render both inside
 * and outside the agent frame (chat turn internals under test, embeds). */
export const useAgentPageAgentMaybe = (): AgentPageAgent | null =>
  useContext(AgentPageContext);

const FrameSkeleton = () => (
  <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
      <Skeleton className="size-8 rounded-lg" />
      <Skeleton className="h-5 w-40" />
    </div>
    <div className="flex min-h-0 flex-1">
      <div className="hidden w-52 shrink-0 space-y-2 border-r p-3 md:block">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
      <SectionShell className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </SectionShell>
    </div>
  </div>
);

/**
 * The client frame behind the agent-page layout: it resolves the agent once
 * and renders the header + rail around whichever section is mounted, so every
 * section can assume its agent exists and is one this kind of agent has.
 */
export const AgentPageFrame = ({
  agentId,
  children,
}: {
  agentId: string;
  children: React.ReactNode;
}) => {
  const pathname = usePathname();
  const { data: agents = [], isPending, isError, refetch } = useAgents();
  const agent = agents.find((a) => a.id === agentId);
  const section = matchAgentPage(pathname)?.section ?? "";

  if (isPending) return <FrameSkeleton />;

  if (isError) {
    // A failed read is not a missing agent — saying "not found" here would
    // turn a transient 500 into apparent data loss.
    return (
      <EmptyState
        icon={AgentIcon}
        title="Couldn't load this agent."
        description="The dashboard couldn't reach the API. It may be a hiccup."
        action={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  if (!agent) {
    return (
      <EmptyState
        icon={AgentIcon}
        title="Agent not found"
        description="It may have been deleted, or the link points at another workspace."
        action={
          <Button variant="outline" size="sm" asChild>
            <Link href={withWorkspacePrefix(pathname, "/agents")}>
              Back to Agents
            </Link>
          </Button>
        }
      />
    );
  }

  // A section this kind of agent doesn't have (a hand-typed URL, or a stale
  // link after switching agents). The rail never offers it; this is the
  // backstop, in one place rather than in each section.
  const blocked = agentSectionBlocked(section, agent.kind);

  return (
    <AgentPageContext.Provider value={agent}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AgentPageHeader agent={agent} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
          <AgentSectionRail agent={agent} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {blocked ? (
              <EmptyState
                tone="quiet"
                title="That section is only available for hosted agents."
              />
            ) : isFullHeightAgentSection(section) ? (
              children
            ) : (
              <SectionShell>{children}</SectionShell>
            )}
          </div>
        </div>
      </div>
    </AgentPageContext.Provider>
  );
};
