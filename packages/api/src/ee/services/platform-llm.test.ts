import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eePlatformLlm } from "./platform-llm";

/**
 * The trial-credit eligibility rule, proven against the two dials it reads:
 * the env-configured platform key (shape-gated, mirroring the gateway's
 * `sk-ant-` rule) and the org/workspace secret pool (any LLM credential —
 * by type or by host — disqualifies).
 */

const KEY = "PLATFORM_ANTHROPIC_API_KEY";

const secret = (type: string, hostPattern: string) => ({ type, hostPattern });

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

  it("applies to an empty pool when the key is configured", () => {
    expect(eePlatformLlm.trialCreditApplies([])).toBe(true);
  });

  it("never applies without the env key", () => {
    delete process.env[KEY];
    expect(eePlatformLlm.trialCreditApplies([])).toBe(false);
  });

  // The deploy provisions the secret with a GENERATED placeholder so tasks
  // boot before an operator pastes the real key — it must read as
  // "unconfigured", exactly as the gateway's parse does.
  it("never applies with a placeholder-shaped key", () => {
    process.env[KEY] = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL";
    expect(eePlatformLlm.trialCreditApplies([])).toBe(false);
  });

  it("any LLM provider key disqualifies — not just Anthropic", () => {
    for (const type of ["anthropic", "openai"]) {
      expect(
        eePlatformLlm.trialCreditApplies([secret(type, "irrelevant.host")]),
        `type ${type}`,
      ).toBe(false);
    }
  });

  it("a generic secret pointed at an LLM host disqualifies", () => {
    expect(
      eePlatformLlm.trialCreditApplies([
        secret("generic", "api.openrouter.ai"),
      ]),
    ).toBe(false);
  });

  it("non-LLM secrets do not disqualify", () => {
    expect(
      eePlatformLlm.trialCreditApplies([
        secret("generic", "api.github.com"),
        secret("generic", "internal.example.com"),
      ]),
    ).toBe(true);
  });
});
