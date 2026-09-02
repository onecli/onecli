import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@onecli/db";
import { defaultAgentSection } from "@/lib/agents/agent-sections";
import { agentSectionPath } from "@/lib/navigation";
import { AgentIndexRedirect } from "./_components/agent-index-redirect";

export const metadata: Metadata = {
  title: "Agent",
};

interface Props {
  params: Promise<{ workspaceId: string; agentId: string }>;
}

/**
 * The agent index is not a page — Overview became the header menu's Details
 * dialog — so it forwards to the first section this agent has: Chat for a
 * hosted agent, Connections for a BYO one.
 *
 * Resolved on the SERVER wherever possible. The client redirect it replaces
 * could only run after the agent list query resolved, so every arrival here
 * (an agent card, a pasted link, the crumb switcher) rendered an empty content
 * pane first — and if that query was slow, errored, or served a cache without
 * this agent, the pane just stayed empty. Reading the one field the decision
 * needs, `kind`, turns the index into a real redirect that never paints.
 *
 * The client component stays as the fallback for the case the server cannot
 * decide (the row isn't visible to this read): the layout above has already
 * proven access, so rendering it is strictly better than a blank page. This
 * read is deliberately NOT an access check — `workspaceId` fences it so it
 * can't leak another workspace's agent, and the layout owns authorization.
 */
export default async function AgentIndexPage({ params }: Props) {
  const { workspaceId, agentId } = await params;

  const agent = await db.agent
    .findFirst({
      where: { id: agentId, workspaceId },
      select: { kind: true },
    })
    .catch(() => null);

  if (agent) {
    redirect(
      agentSectionPath(
        `/w/${workspaceId}/agents/${agentId}`,
        agentId,
        defaultAgentSection(agent.kind),
      ),
    );
  }

  return <AgentIndexRedirect />;
}
