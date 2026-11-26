/**
 * Whether an agent's gateway proxy token may be handed to a person at all:
 * the ONE rule every read and rotate path applies (the agent list, the
 * container config, token rotation).
 *
 * A BYO agent runs on the customer's own machine, so the customer must hold
 * its token: they configure their runtime with it (`onecli run`, the SDK's
 * container config). A hosted agent never runs outside the platform's
 * sandbox, which receives its token server-side through the runner channel,
 * so no person ever needs it, and a token that left the sandbox would let
 * anyone drive the gateway as that agent, from anywhere, with everything the
 * agent is entitled to. So it is never returned for a hosted agent.
 *
 * Its own module, free of service imports, so the agent and container-config
 * services can share it without importing each other.
 */
export const agentTokenIsUserVisible = (kind: string): boolean =>
  kind !== "hosted";
