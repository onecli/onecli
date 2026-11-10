"use client";

import { ActivityContent } from "../../../../activity/_components/activity-content";
import { useAgentPageAgent } from "../../_components/agent-page-frame";

/**
 * The agent's Activity, under More: the
 * workspace Activity page pinned to this agent. Runs (one row per task:
 * chat, Slack or schedule) and Traffic (the gateway log). The workspace
 * wide view stays at `/w/[id]/activity` (the Settings modal's Activity).
 */
export const AgentActivitySection = () => {
  const agent = useAgentPageAgent();
  return <ActivityContent pinnedAgent={{ id: agent.id, name: agent.name }} />;
};
