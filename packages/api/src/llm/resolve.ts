import type { AgentEffort } from "@onecli/agent-protocol";
import type { LlmProviderId } from "./types";
import { llmProvider } from "./registry";

export interface AgentModelOverride {
  model: string | null;
  effort: string | null;
  /** The provider the override belongs to; null when nothing is overridden. */
  modelProvider: string | null;
}

export interface ResolvedModel {
  /** The PROVIDER's id; the harness adapter translates it (§3.5). */
  model: string;
  /** Absent = send no effort and let the provider's own default stand. */
  effort?: AgentEffort;
  /** Whether the user chose either of these, or they came from the registry. */
  overridden: boolean;
}

/**
 * What this agent should run, given the provider its granted key names.
 *
 * PURE WITH RESPECT TO THE NETWORK — it reads the agent's override and the
 * registry's PINNED defaults, never the catalog cache and never the wire. That
 * is what §3.10 means by "boot must never depend on an outbound call": this is
 * the function the spawn payload calls.
 *
 * The provider comparison is the belt to the braces worn by `grants-service`,
 * which clears the override when the granted key changes provider. Checking it
 * on READ too means a missed clear degrades to the provider's default instead
 * of shipping a foreign model id to a harness that will reject it.
 */
export const resolveAgentModel = (
  agent: AgentModelOverride,
  provider: LlmProviderId,
): ResolvedModel => {
  const definition = llmProvider(provider);
  const stale = agent.modelProvider !== provider;
  const model = (!stale && agent.model) || definition.defaultModel;

  // A level this provider cannot express is dropped rather than forwarded —
  // the same read-side defensiveness as the provider check above.
  const chosen = stale ? null : agent.effort;
  const effort =
    definition.efforts.find((option) => option.id === chosen)?.id ??
    definition.defaultEffort;

  return {
    model,
    ...(effort && { effort }),
    // Derived from what SURVIVED, not from what is stored. An override this
    // function just discarded — a foreign provider's stamp, or a level this
    // provider cannot express — must not still be reported as the user's
    // choice: the Models card renders that flag as "Your choice", and it would
    // be pointing at a value identical to the default.
    overridden:
      model !== definition.defaultModel || effort !== definition.defaultEffort,
  };
};
