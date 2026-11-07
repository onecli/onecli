"use client";

import { useConnectionEffectiveAgents } from "@/lib/api/policy-visibility";
import { useConnectionGrants } from "@/hooks/use-grants";
import type { ConnectionAgentsReflectionProps } from "@/lib/components/policy-reflect";
import { AgentAccessDialog } from "./agent-access-dialog";
import { agentConnectionState } from "./agent-connection-state";
import { ConnectionAgentAccessRow } from "./connection-agent-access-row";

// The post-connect "agent access" dialog: opened straight off a successful
// connect on the workspace's Connections page, where it IS the setup step that
// used to be crammed into the 520px OAuth popup. A new account starts on for
// no agent (a connect started from an agent's link: that agent alone), so
// this is where the user turns it on, agent by agent. Each row
// carries the attach toggle + a Manage deep-link into the agent page's
// permissions sheet, while the effective framing stays (lead with what the
// agent can DO; credential detail is secondary). Writes go through the grants
// API's connection orientation. An established account's agents are edited in
// place on its card (`ConnectionAgentRows`).

export const ConnectionAgentsReflection = ({
  connectionId,
  appName,
  open,
  onOpenChange,
}: ConnectionAgentsReflectionProps) => {
  const effectiveQuery = useConnectionEffectiveAgents(connectionId, open);
  const grantsQuery = useConnectionGrants(connectionId, open);

  // Toggles must never render over unknown grant state — both the effective
  // view AND the grants view have to resolve first (the workspace-access rule).
  const result = effectiveQuery.data;
  const grantedAgentIds = new Set(
    (grantsQuery.data?.agents ?? []).map((a) => a.agentId),
  );
  // The copy states what is true now: off for everyone, unless the connect
  // came through an agent's link (that agent starts on) or an org rule
  // already grants it.
  const loaded = effectiveQuery.isSuccess && grantsQuery.isSuccess;
  const noneOn =
    loaded &&
    !(result?.agents ?? []).some(
      (agent) =>
        agentConnectionState(agent, grantedAgentIds.has(agent.agentId)).on,
    );

  return (
    <AgentAccessDialog
      title={`${appName} connected`}
      description={
        noneOn
          ? "It's off for every agent. Turn it on for the agents that should use it. Changes apply immediately."
          : "Choose which agents can use it. Changes apply immediately."
      }
      open={open}
      onOpenChange={onOpenChange}
      isPending={effectiveQuery.isPending || grantsQuery.isPending}
      isError={effectiveQuery.isError || grantsQuery.isError}
      subject="this connection"
      isEmpty={!result || result.agents.length === 0}
      notice={
        result && !result.catalog ? (
          <p className="bg-muted/40 text-muted-foreground mb-1 rounded-md border px-3 py-2 text-xs">
            This app has no permission catalog. Access is governed by network
            rules only.
          </p>
        ) : undefined
      }
    >
      {result?.agents.map((agent) => (
        <ConnectionAgentAccessRow
          key={agent.agentId}
          connectionId={connectionId}
          agent={agent}
          workspaceGranted={grantedAgentIds.has(agent.agentId)}
        />
      ))}
    </AgentAccessDialog>
  );
};
