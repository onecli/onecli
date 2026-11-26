"use client";

import { AgentIcon } from "@/lib/agents/agent-icon";
import { Switch } from "@onecli/ui/components/switch";
import type { SecretAgentAccessEntry } from "@/lib/api";
import { useAttachSecret, useDetachSecret } from "@/hooks/use-grants";

export interface SecretAgentAccessRowProps {
  secretId: string;
  agent: SecretAgentAccessEntry;
}

/**
 * One agent row of the custom connection's "choose agents" window: the
 * agent's own switch for this secret, the same attach/detach the agent page's
 * Custom tab writes. An agent an ORG rule grants it to reads on and locked
 * (not detachable at workspace level), like everywhere else.
 */
export const SecretAgentAccessRow = ({
  secretId,
  agent,
}: SecretAgentAccessRowProps) => {
  const attach = useAttachSecret();
  const detach = useDetachSecret();
  const on = agent.granted || agent.orgGranted;

  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-md">
          <AgentIcon
            className="text-muted-foreground size-3.5"
            aria-hidden="true"
          />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm">{agent.name}</span>
          {agent.orgGranted && (
            <span className="text-muted-foreground block truncate text-[11px]">
              Via organization
            </span>
          )}
        </span>
      </span>
      <Switch
        size="sm"
        checked={on}
        // Locked only by the org, never by an in-flight write: the switch
        // moves on click (optimistic) and the next click queues behind it.
        disabled={agent.orgGranted}
        aria-label={`${on ? "Detach" : "Attach"} ${agent.name}`}
        onCheckedChange={(next) => {
          if (next) attach.mutate({ agentId: agent.agentId, secretId });
          else detach.mutate({ agentId: agent.agentId, secretId });
        }}
      />
    </div>
  );
};
