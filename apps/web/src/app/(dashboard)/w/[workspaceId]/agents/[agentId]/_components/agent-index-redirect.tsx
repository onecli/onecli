"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { agentSectionPath } from "@/lib/navigation";
import { defaultAgentSection } from "@/lib/agents/agent-sections";
import { useAgentPageAgent } from "./agent-page-frame";

/**
 * The agent index is not a page any more — Overview became the header menu's
 * Details dialog. It forwards to the first section this agent has (Chat for a
 * hosted agent, Connections for a BYO one), so every old `/agents/<id>` link
 * still lands somewhere real. `replace`, not `push`: the index must not sit
 * in history as a step back into a redirect loop.
 */
export const AgentIndexRedirect = () => {
  const agent = useAgentPageAgent();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    router.replace(
      agentSectionPath(pathname, agent.id, defaultAgentSection(agent.kind)),
    );
  }, [router, pathname, agent.id, agent.kind]);

  return null;
};
