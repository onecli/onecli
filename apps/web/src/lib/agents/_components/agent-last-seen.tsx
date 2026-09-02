"use client";

import { agentLastSeen } from "@onecli/api/lib/agent-activity";

/**
 * When this agent was last heard from — one element, never a second status
 * chip: the freshness dot lives INSIDE the text and only for activity within
 * the hour. "Seen" is always last-request-time, never presence (the agent's
 * own state is `AgentStatusPill`'s job). Shared by the agent card and the
 * agent page so the two can't word it differently.
 */
export const AgentLastSeen = ({
  lastSeenAt,
  createdAt,
}: {
  lastSeenAt: Date | null;
  createdAt: Date;
}) => {
  const lastSeen = agentLastSeen(lastSeenAt, createdAt);
  return (
    <span
      className="text-muted-foreground inline-flex items-center gap-1.5"
      title={lastSeen.exactAt?.toLocaleString()}
    >
      {lastSeen.fresh && (
        <span aria-hidden className="bg-brand size-1.5 shrink-0 rounded-full" />
      )}
      {lastSeen.label}
    </span>
  );
};
