"use client";

import { useSecretAgentAccess } from "@/hooks/use-grants";
import type { SecretAgentsDialogProps } from "@/lib/components/policy-reflect";
import { AgentAccessDialog } from "./agent-access-dialog";
import { SecretAgentAccessRow } from "./secret-agent-access-row";

/**
 * The custom connection's "choose agents" window: opened straight after a
 * custom connection is added on the workspace's Custom tab (it starts on for
 * no agent), and from its card afterwards. The secret twin of the app
 * account's agent-access dialog, on the same shell.
 */
export const SecretAgentsDialog = ({
  secretId,
  secretName,
  justAdded = false,
  open,
  onOpenChange,
}: SecretAgentsDialogProps) => {
  const accessQuery = useSecretAgentAccess(secretId, open);
  const agents = accessQuery.data?.agents ?? [];

  return (
    <AgentAccessDialog
      title={justAdded ? `${secretName} added` : `${secretName} agents`}
      added={justAdded}
      description={
        // States what is true now: only a just-added secret nobody has yet
        // (an org rule can grant one on arrival) is "off for every agent",
        // and only once that is known.
        justAdded &&
        accessQuery.isSuccess &&
        !agents.some((agent) => agent.granted || agent.orgGranted)
          ? "It's off for every agent. Turn it on for the agents that should use it. Changes apply immediately."
          : "Choose which agents can use this connection. Changes apply immediately."
      }
      open={open}
      onOpenChange={onOpenChange}
      isPending={accessQuery.isPending}
      isError={accessQuery.isError}
      subject="this connection"
      isEmpty={agents.length === 0}
    >
      {agents.map((agent) => (
        <SecretAgentAccessRow
          key={agent.agentId}
          secretId={secretId}
          agent={agent}
        />
      ))}
    </AgentAccessDialog>
  );
};
