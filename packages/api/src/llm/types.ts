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
   * Left undefined on purpose: absent means "send no effort at all and let the
   * provider's own default stand", which is both the safest wire behaviour and
   * the only one that cannot be rejected for a model whose accepted set we
   * guessed wrong. An explicit level is always a user's choice.
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
  /**
   * Can a credential of this auth mode list at all? Asked BEFORE the
   * credential is obtained, because obtaining it costs a KMS decrypt and the
   * answer here does not depend on its value.
   *
   * `false` is a NORMAL state, not an error: an OAuth blob's access token is
   * refreshed by the gateway, which the control plane must not reimplement.
   * That arm serves the pinned list instead.
   */
  canList: (authMode: "api-key" | "oauth") => boolean;
  catalogHeaders: (credential: string) => Record<string, string>;
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
}
