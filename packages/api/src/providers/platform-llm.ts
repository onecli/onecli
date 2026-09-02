/**
 * The platform-provided LLM trial credit seam (cloud-only feature; the
 * implementation is licensed and lives in `ee/services/platform-llm.ts`,
 * injected at boot by `ensureEditionDefaults()`).
 *
 * `pool` is the agent's org+workspace fenced secret pool BEFORE grant
 * narrowing — the same eligibility input the gateway uses
 * (`ee/platform_llm.rs`), so "the control plane advertises Anthropic" and
 * "the gateway injects the platform key" can never disagree.
 *
 * DELIBERATELY not a fail-loud `createEditionSlot`: those throw on an
 * uninjected cloud read because their fall-through would silently DISABLE an
 * enforcement (quotas, RBAC, KMS). This seam has the opposite polarity — an
 * uninjected read means NO free credit is offered, which is the safe state —
 * so the getter resolves `null` in both editions until the cloud boot injects
 * the licensed implementation. Storage mirrors `providers/edition-state.ts`:
 * `globalThis` per process (Next.js dev isolates module registries per route
 * graph), module scope under test (vitest shares a worker's globalThis
 * across files).
 */
export interface PlatformLlmProvider {
  /**
   * Whether the platform trial credit applies to an org/workspace whose
   * UNFILTERED secret pool is `pool` — an existing-but-restricted LLM key
   * counts as present, so a restriction is never bypassed with free credit.
   */
  trialCreditApplies: (
    pool: ReadonlyArray<{ type: string; hostPattern: string }>,
  ) => boolean;
}

/**
 * Sentinel `secretId` of the platform trial credential — the same id the
 * gateway uses for its synthesized budget binding (`platform_llm.rs`). Never
 * collides with a real `secrets.id` (UUIDs). Control-plane callers use it to
 * tell "the platform's key" apart from a user's secret (nothing may try to
 * decrypt or grant it).
 */
export const PLATFORM_LLM_SECRET_ID = "platform:anthropic";

interface Slot {
  value: PlatformLlmProvider | null;
}

const globalForPlatformLlm = globalThis as unknown as {
  __onecliPlatformLlm?: Slot;
};

const slot: Slot =
  process.env.NODE_ENV === "test"
    ? { value: null }
    : (globalForPlatformLlm.__onecliPlatformLlm ??= { value: null });

/** Tests: install a stub, or `null` to reset to dark. */
export const initPlatformLlm = (p: PlatformLlmProvider | null): void => {
  slot.value = p;
};

/** Package-internal: the `ensureEditionDefaults()` injector. Not exported from the barrel. */
export const setDefaultPlatformLlm = (p: PlatformLlmProvider): void => {
  slot.value = p;
};

/** The injected provider, or `null` (onprem always; cloud before boot injection). */
export const getPlatformLlm = (): PlatformLlmProvider | null => slot.value;
