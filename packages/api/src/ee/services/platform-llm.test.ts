import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eePlatformLlm, ownerTrustedForTrialCredit } from "./platform-llm";
import ownerCases from "./trial-credit-owner-cases.json";

/**
 * The trial-credit eligibility rule, proven against the three dials it reads:
 * the env-configured platform key (shape-gated, mirroring the gateway's
 * `sk-ant-` rule), the org/workspace secret pool (any LLM credential — by
 * type or by host — disqualifies), and the org's founding owner (a Google
 * sign-in or a non-consumer-Microsoft address).
 */

const KEY = "PLATFORM_ANTHROPIC_API_KEY";

const secret = (type: string, hostPattern: string) => ({ type, hostPattern });

/** A trusted owner, so the pool and key dials are tested on their own. */
const TRUSTED = { email: "person@company.example", signInProvider: null };

describe("eePlatformLlm.trialCreditApplies", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
    process.env[KEY] = "sk-ant-api03-platform-key";
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("applies to an empty pool and a trusted owner when the key is configured", () => {
    expect(eePlatformLlm.trialCreditApplies([], TRUSTED)).toBe(true);
  });

  it("never applies without the env key", () => {
    delete process.env[KEY];
    expect(eePlatformLlm.trialCreditApplies([], TRUSTED)).toBe(false);
  });

  // The deploy provisions the secret with a GENERATED placeholder so tasks
  // boot before an operator pastes the real key — it must read as
  // "unconfigured", exactly as the gateway's parse does.
  it("never applies with a placeholder-shaped key", () => {
    process.env[KEY] = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL";
    expect(eePlatformLlm.trialCreditApplies([], TRUSTED)).toBe(false);
  });

  it("any LLM provider key disqualifies — not just Anthropic", () => {
    for (const type of ["anthropic", "openai"]) {
      expect(
        eePlatformLlm.trialCreditApplies(
          [secret(type, "irrelevant.host")],
          TRUSTED,
        ),
        `type ${type}`,
      ).toBe(false);
    }
  });

  it("a generic secret pointed at an LLM host disqualifies", () => {
    expect(
      eePlatformLlm.trialCreditApplies(
        [secret("generic", "api.openrouter.ai")],
        TRUSTED,
      ),
    ).toBe(false);
  });

  it("non-LLM secrets do not disqualify", () => {
    expect(
      eePlatformLlm.trialCreditApplies(
        [
          secret("generic", "api.github.com"),
          secret("generic", "internal.example.com"),
        ],
        TRUSTED,
      ),
    ).toBe(true);
  });

  it("an untrusted owner gets none, even with an empty pool and the key set", () => {
    expect(
      eePlatformLlm.trialCreditApplies([], {
        email: "AlexKim123@outlook.com",
        signInProvider: null,
      }),
    ).toBe(false);
  });

  it("an org with no active owner gets none", () => {
    expect(eePlatformLlm.trialCreditApplies([], null)).toBe(false);
  });
});

// The SAME table the gateway's Rust suite reads (platform_llm.rs
// `owner_trust_matches_the_shared_table`): the control plane must never
// advertise a credit the gateway refuses to inject, or the reverse.
describe("ownerTrustedForTrialCredit (shared table with the gateway)", () => {
  it("has a non-trivial table", () => {
    expect(ownerCases.cases.length).toBeGreaterThanOrEqual(15);
  });

  it.each(ownerCases.cases)("$name", ({ email, signInProvider, trusted }) => {
    expect(ownerTrustedForTrialCredit({ email, signInProvider })).toBe(trusted);
  });

  it("refuses an org with no active owner", () => {
    expect(ownerTrustedForTrialCredit(null)).toBe(false);
  });
});
