import type { EffectiveAgentEntry } from "@/lib/api/policy-visibility";

/**
 * One agent's standing on one connection, from the effective view (the
 * enforced rules) and the workspace grants. The single derivation behind
 * every per-agent connection row, so the account card and the Agent access
 * dialog can never disagree about who is on, granted by the org, or blocked.
 */
export interface AgentConnectionState {
  /** A workspace grant (the switch's own state): detachable. */
  workspaceGranted: boolean;
  /** Injected by an org rule with no workspace grant: on, and locked. */
  orgGranted: boolean;
  /** On, by either route. */
  on: boolean;
  /** Attached, but every tool is blocked by a rule. */
  blocked: boolean;
}

export const agentConnectionState = (
  agent: EffectiveAgentEntry,
  workspaceGranted: boolean,
): AgentConnectionState => {
  const orgGranted =
    !workspaceGranted &&
    agent.credential.status === "viaRule" &&
    agent.credential.provenance.some((p) => p.scope === "organization");
  return {
    workspaceGranted,
    orgGranted,
    on: workspaceGranted || orgGranted,
    blocked: agent.access === "blocked",
  };
};
