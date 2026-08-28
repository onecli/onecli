import type { LlmProvider, LlmProviderId } from "./types";
import { anthropic } from "./anthropic";
import { openai } from "./openai";

// SERVER-ONLY (see `./types`): this registry reaches outbound fetch logic and
// decrypted credentials. Client code gets its data from the models endpoint.

/**
 * Every provider we can pick a model for. THE one list — a `Record` keyed by
 * the id union, so adding a provider to `LlmProviderId` without adding it here
 * is a compile error, and everything else (query filters, tie-break order) is
 * derived from it rather than repeated beside it.
 */
export const LLM_PROVIDERS: Record<LlmProviderId, LlmProvider> = {
  anthropic,
  openai,
};

/** The secret types this registry can serve — derived, never hand-listed. */
export const LLM_PROVIDER_IDS = Object.keys(LLM_PROVIDERS) as LlmProviderId[];

/**
 * Is this secret type one we can pick a model for?
 *
 * `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `"toString"`,
 * `"constructor"` and `"__proto__"` would all answer true — and `llmProvider`
 * would then hand back `Object.prototype.constructor`, whose `.isSelectable`
 * is not a function.
 *
 * Note the asymmetry with the product's other definition of "LLM secret",
 * which is the negative `type !== "generic"` (`grants-summary-service`). That
 * one classifies a credential for display; this one asserts we have a provider
 * entry, so a future typed secret can exist without silently becoming
 * un-modelled.
 */
export const isLlmProviderId = (type: string): type is LlmProviderId =>
  Object.hasOwn(LLM_PROVIDERS, type);

export const llmProvider = (id: LlmProviderId): LlmProvider =>
  LLM_PROVIDERS[id];
