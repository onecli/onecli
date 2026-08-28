import type { AgentEffort } from "@onecli/agent-protocol";
import { ServiceError } from "./errors";
import {
  loadAgentForLlm,
  readLlmCredentialValue,
  resolveAgentLlmCredential,
} from "./llm-credential-service";
import { injectableSecretWhere } from "./injectable-secrets";
import { getModelCatalog } from "../llm/catalog-cache";
import { llmProvider } from "../llm/registry";
import { resolveAgentModel } from "../llm/resolve";
import type { LlmProviderId, ModelOption } from "../llm/types";

/**
 * What an agent can be set to run, and what it is running now (§3.10).
 *
 * The shape answers the whole Models section in one call — which provider its
 * key names, that provider's models and effort levels, the defaults, and the
 * current selection — so the UI never has to assemble a picture from several
 * requests that can disagree with each other.
 */
export interface AgentModelsView {
  /** null = no injectable LLM key. A legitimate answer, not an error. */
  provider: LlmProviderId | null;
  providerLabel: string | null;
  /** Which grant won, so the UI can explain a surprising provider. */
  providerScope: string | null;
  models: ModelOption[];
  efforts: readonly { id: AgentEffort; label: string }[];
  /** What this agent runs when nothing is overridden. */
  defaults: { model: string; effort: AgentEffort | null };
  /** What it runs right now, and whether that came from the user. */
  selected: { model: string; effort: AgentEffort | null; overridden: boolean };
  /** The list is pinned or stale rather than freshly fetched. */
  degraded: boolean;
}

const EMPTY: AgentModelsView = {
  provider: null,
  providerLabel: null,
  providerScope: null,
  models: [],
  efforts: [],
  defaults: { model: "", effort: null },
  selected: { model: "", effort: null, overridden: false },
  degraded: false,
};

export const getAgentModels = async (
  workspaceId: string,
  agentId: string,
): Promise<AgentModelsView> => {
  const agent = await loadAgentForLlm(workspaceId, agentId);
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  if (agent.kind !== "hosted")
    throw new ServiceError(
      "UNPROCESSABLE",
      "Only hosted agents run a platform-chosen model",
    );

  // Computed once and threaded through both reads below: it is three queries
  // to build, and both must see exactly the same fenced selection.
  const injectable = await injectableSecretWhere(
    { id: agent.id },
    agent.workspaceId,
    agent.workspace.organizationId,
  );
  const credential = await resolveAgentLlmCredential(
    { id: agent.id, workspaceId: agent.workspaceId },
    agent.workspace.organizationId,
    injectable,
  );
  // No key yet. Answered as an EMPTY VIEW rather than an error, because the
  // resource exists and "none yet" is a legitimate state (§3.18 rule 3) — and
  // because the same payload drives the quiet indicator, which needs to tell
  // "no key" from "the server broke". A status code cannot say both.
  //
  // And never the union of every provider we support: §3.10 is explicit that
  // the UI shows only what is actually injectable, or a user picks a model
  // that fails later with an opaque upstream 401.
  if (!credential) return EMPTY;

  const provider = llmProvider(credential.provider);
  // Passed as a thunk so a warm catalog costs no decrypt at all — see
  // `getModelCatalog`. The plaintext is used for one outbound request and
  // never stored, logged, or returned.
  const { models, degraded } = await getModelCatalog(
    provider,
    credential.secretId,
    async () =>
      credential.hasReadableValue
        ? await readLlmCredentialValue(
            { id: agent.id, workspaceId: agent.workspaceId },
            agent.workspace.organizationId,
            credential.secretId,
            injectable,
          )
        : null,
    credential.authMode,
  );
  const selected = resolveAgentModel(agent, credential.provider);

  return {
    provider: credential.provider,
    providerLabel: provider.label,
    providerScope: credential.scope,
    models,
    efforts: provider.efforts,
    defaults: {
      model: provider.defaultModel,
      effort: provider.defaultEffort ?? null,
    },
    selected: {
      model: selected.model,
      effort: selected.effort ?? null,
      overridden: selected.overridden,
    },
    degraded,
  };
};
