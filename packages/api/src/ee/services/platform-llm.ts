import { LLM_HOST_FRAGMENTS } from "../../lib/llm-hosts";
import type { PlatformLlmProvider } from "../../providers/platform-llm";

/**
 * Platform-provided Anthropic trial credit — the control-plane half (licensed,
 * cloud-only; the enforcement half is the gateway's `ee/platform_llm.rs`).
 *
 * The control plane never touches the key's VALUE beyond an env presence /
 * shape check: injection happens exclusively at the gateway, so the
 * zero-credential sandbox invariant holds — a hosted container still receives
 * only the `"placeholder"` env var. What this module decides is whether the
 * platform credential WOULD inject for an agent whose pool has no LLM key,
 * so the container config can advertise `ANTHROPIC_API_KEY` (harnesses pick
 * their provider by which variable is set) and the hosted start path can
 * accept a keyless agent instead of refusing to boot it.
 *
 * The two halves stay in agreement by construction: both read the same env
 * vars (the deploy wires the same Secrets Manager secret into both task
 * definitions) and mirror the same key-shape rule (`sk-ant-` prefix — the
 * deploy provisions the secret with a generated placeholder so tasks can
 * boot before an operator pastes the real key; the placeholder must read as
 * "unconfigured" on both sides).
 */

/** Mirrors the gateway's `sk-ant-` shape gate (`platform_llm.rs::parse`). */
const looksLikeAnthropicKey = (value: string | undefined): boolean =>
  (value ?? "").trim().startsWith("sk-ant-");

/**
 * Read at call time (not module load) so long-lived processes and tests see
 * the current env — the `policy-flags.ts` posture, chosen over the module-load
 * read because this module is licensed and must be inert when the platform
 * key is withdrawn without a redeploy of every consumer.
 */
const configured = (): boolean =>
  looksLikeAnthropicKey(process.env.PLATFORM_ANTHROPIC_API_KEY);

/**
 * Whether a secret disqualifies the trial credit — the TS mirror of the
 * gateway's `pool_has_llm_credential`: any LLM credential, by provider type
 * or by a host pattern reaching an LLM host, means the user brought their own
 * key. `type` covers anthropic/openai; the fragment scan covers `generic`
 * secrets pointed at any LLM provider.
 */
const isLlmSecret = (secret: { type: string; hostPattern: string }): boolean =>
  secret.type === "anthropic" ||
  secret.type === "openai" ||
  LLM_HOST_FRAGMENTS.some((fragment) => secret.hostPattern.includes(fragment));

export const eePlatformLlm: PlatformLlmProvider = {
  /**
   * Whether the platform trial credit applies to an org/workspace whose
   * UNFILTERED secret pool is `pool`. The pool must be the org+workspace
   * fenced pool BEFORE grant narrowing — an existing-but-restricted LLM key
   * counts as present, so a restriction is never bypassed with free credit
   * (the same rule the gateway applies at connect).
   */
  trialCreditApplies: (pool) => configured() && !pool.some(isLlmSecret),
};
