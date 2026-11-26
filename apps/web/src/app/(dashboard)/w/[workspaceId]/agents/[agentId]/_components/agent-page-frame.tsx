"use client";

import { createContext, useContext, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AgentIcon } from "@/lib/agents/agent-icon";
import { Button } from "@onecli/ui/components/button";
import { matchAgentPage, withWorkspacePrefix } from "@/lib/navigation";
import { agentSectionBlocked } from "@/lib/agents/agent-sections";
import { useAgents, useWarmAgent } from "@/hooks/use-agents";
import { AgentSectionCell } from "./agent-section-cell";
import { AgentSectionSkeleton } from "./agent-section-skeleton";
import { EmptyState } from "./empty-state";

/**
 * The agent row the list query actually yields — derived from the hook rather
 * than restated, so it cannot drift from it (`GET /v1/agents`'s `Agent`).
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

/**
 * The client frame behind the agent-page layout: it resolves the agent once
 * and renders the section inside it, so every section can assume its agent
 * exists and is one this kind of agent has. The dashboard's sidebar names
 * the agent and lists its sections, so the frame adds no chrome of its own.
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

  // A person on ANY section of a hosted agent's page is likely heading for
  // its chat (or a section that needs the machine: Computer, SSH, Ports):
  // warm it now, so the message they type after reading Schedules does not
  // pay the boot. Once per agent per page load (the hook dedupes); a BYO
  // agent has no machine and sends nothing.
  const warm = useWarmAgent();
  const agentIdentity = agent?.id;
  const agentKind = agent?.kind;
  useEffect(() => {
    if (agentIdentity && agentKind)
      warm({ id: agentIdentity, kind: agentKind });
  }, [warm, agentIdentity, agentKind]);

  if (isPending)
    return (
      <AgentSectionCell section={section}>
        <AgentSectionSkeleton section={section} />
      </AgentSectionCell>
    );

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
            <Link href={withWorkspacePrefix(pathname, "")}>
              Back to workspace
            </Link>
          </Button>
        }
      />
    );
  }

  // A section this kind of agent doesn't have (a hand-typed URL, or a stale
  // link after switching agents). The sidebar never offers it; this is the
  // backstop, in one place rather than in each section.
  const blocked = agentSectionBlocked(section, agent.kind);

  return (
    <AgentPageContext.Provider value={agent}>
      {blocked ? (
        <AgentSectionCell section={section} shell={false}>
          <EmptyState
            tone="quiet"
            title="That section is only available for hosted agents."
          />
        </AgentSectionCell>
      ) : (
        <AgentSectionCell section={section}>{children}</AgentSectionCell>
      )}
    </AgentPageContext.Provider>
  );
};
