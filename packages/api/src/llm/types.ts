/**
 * The LLM provider registry's vocabulary (§3.10).
 *
 * SERVER-ONLY — the exact inverse of `../apps/registry.ts`, which announces
 * itself as client-safe because client components import it. This registry
 * holds outbound fetch logic and is reached from paths that decrypt a customer
 * credential, so it must never enter a client bundle. The browser sees this
 * data through `GET /v1/agents/:agentId/models` and nowhere else.
 *
 * Adding a provider is one file plus one line in `registry.ts`.
 */

import type { AgentEffort } from "@onecli/agent-protocol";

/**
 * A provider id. Deliberately the SAME string as `Secret.type`, so a granted
 * key names its own provider with no mapping table in between — which is what
 * makes "the key decides the model" a lookup rather than a negotiation.
 */
export type LlmProviderId = "anthropic" | "openai";

/**
 * How a stored LLM credential authenticates, from `Secret.metadata.authMode`:
 * a Console API key, or the OAuth credential a subscription login produced.
 * Legacy rows with no metadata are `api-key`.
 */
export type LlmAuthMode = "api-key" | "oauth";

export interface ModelOption {
  /**
   * The PROVIDER's own model id, always — `claude-sonnet-4-6`, never a harness
   * alias like `sonnet-4.6`. Whichever harness ends up running this agent is
   * responsible for translating into its own vocabulary; the control plane
   * does not know or care which one that is (§3.5, and the `Harness`
   * interface's own invariant: nothing above the adapter knows the vendor).
   */
  id: string;
  label: string;
  /** Where the entry came from, so the UI can be honest about a stale list. */
  source: "live" | "pinned";
}

export interface EffortOption {
  id: AgentEffort;
  label: string;
}

export interface LlmProvider {
  id: LlmProviderId;
  label: string;
  /**
   * Tie-break rank when an agent holds two granted keys AT THE SAME SCOPE.
   * Lower wins. A field rather than a separate ordered list, because the
   * `Record<LlmProviderId, LlmProvider>` below makes this exhaustive by
   * construction — a parallel array would let a new provider be forgotten,
   * and a forgotten provider is invisible rather than merely mis-ranked.
   */
  order: number;
  /**
   * The model an agent runs when nobody has chosen one. MUST be resolvable
   * with no network: this is the boot path, and §3.10 forbids a sandbox start
   * depending on an outbound call.
   */
  defaultModel: string;
  /**
   * The level the DEFAULT model runs at when the user chose none. Applied to
   * the default model only, whose id is known to accept it: a model the user
   * picks runs at its own default unless they also pick a level, because a
   * forced level is refused by a model with no reasoning control. Absent =
   * send no effort and let the provider's own default stand.
   */
  defaultEffort?: AgentEffort;
  /** Which levels of OUR scale this provider can express. */
  efforts: readonly EffortOption[];
  /**
   * HARDCODED per provider. Never derived from `Secret.hostPattern`, which is
   * user-editable (`secret-service.ts` writes it unconditionally) — building an
   * outbound URL from it would turn "connect a key" into an SSRF primitive
   * against our own network.
   */
  catalogUrl: string;
  /** Same headers the gateway injects for this auth mode, so the catalog is
   *  the inventory of the credential the agent actually runs on. */
  catalogHeaders: (
    credential: string,
    authMode: LlmAuthMode,
  ) => Record<string, string>;
  parseCatalog: (body: unknown) => Array<{ id: string; label?: string }>;
  /**
   * Is this id a chat model a hosted agent could actually run? A prefix rule
   * rather than an allow-list, so a model released tomorrow appears with no
   * deploy — which is the whole point of fetching the list live.
   */
  isSelectable: (id: string) => boolean;
  labelFor: (id: string) => string;
  /** The offline answer. NEVER EMPTY — an empty dropdown is not a legal state. */
  fallback: readonly string[];
  /**
   * What a subscription (OAuth) login answers differently, for a provider
   * whose login is a different product from its API: OpenAI's ChatGPT login
   * lists on `chatgpt.com` and refuses some API models outright ("not
   * supported when using Codex with a ChatGPT account"). Every field keeps the
   * rule of the one it replaces. Read through `forAuthMode`, never directly.
   */
  oauth?: Partial<LlmAuthAnswers>;
}

/** The parts of a provider that depend on how its credential authenticates. */
export type LlmAuthAnswers = Pick<
  LlmProvider,
  "defaultModel" | "catalogUrl" | "parseCatalog" | "fallback"
>;
