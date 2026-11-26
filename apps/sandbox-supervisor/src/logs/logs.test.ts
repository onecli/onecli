import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../log";
import { createRateLimiter } from "./rate-limiter";
import { redactSecrets } from "./redact";

describe("rate limiter", () => {
  it("passes a burst, refuses past it, and counts every refusal", () => {
    let now = 0;
    const limiter = createRateLimiter({
      ratePerSecond: 1,
      burst: 3,
      now: () => now,
    });
    expect([1, 2, 3, 4, 5].map(() => limiter.tryTake())).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(limiter.takeSuppressed()).toBe(2);
    expect(limiter.takeSuppressed()).toBe(0);
    now = 1_000;
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(false);
  });

  it("refills at the sustained rate but never above the burst", () => {
    let now = 0;
    const limiter = createRateLimiter({
      ratePerSecond: 10,
      burst: 2,
      now: () => now,
    });
    limiter.tryTake();
    limiter.tryTake();
    now = 60_000;
    expect([1, 2, 3].map(() => limiter.tryTake())).toEqual([true, true, false]);
  });
});

describe("redactSecrets", () => {
  const hex = "0123456789abcdef".repeat(4);

  it.each([
    ["agent proxy", `http://x:aoc_${hex}@gateway:10255`, "aoc_[REDACTED]"],
    ["user api key", `Bearer oc_${hex}`, "oc_[REDACTED]"],
    ["org api key", `key=oc_org_${hex}`, "oc_org_[REDACTED]"],
    ["runner token", `rnr_${hex}`, "rnr_[REDACTED]"],
    ["underscore-glued", `PROXY_aoc_${hex}`, "PROXY_aoc_[REDACTED]"],
    ["scim token", `Bearer oc_scim_${hex}`, "oc_scim_[REDACTED]"],
    ["channel adapter token", `cha_${hex}`, "cha_[REDACTED]"],
  ])(
    "redacts the %s family, keeping the prefix",
    (_family, input, expected) => {
      const out = redactSecrets(input);
      expect(out).toContain(expected);
      expect(out).not.toContain(hex);
    },
  );

  it("leaves ordinary words and short prefixes alone", () => {
    const text = "docs_oc_ file aoc_short rnr_ batch_oc_process";
    expect(redactSecrets(text)).toBe(text);
  });

  it("does not double-match the oc_ inside aoc_", () => {
    expect(redactSecrets(`aoc_${hex}`)).toBe("aoc_[REDACTED]");
  });
});

describe("log() redacts every value it writes", () => {
  const hex = "0123456789abcdef".repeat(4);
  const captured = (): string[] => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    return lines;
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    // Each control character sits IMMEDIATELY before the prefix: that is
    // exactly where serialization puts a letter (`\n` → `\` `n`) that a
    // line-level lookbehind refuses to cross.
    ["after a newline", `connect failed:\naoc_${hex}`],
    ["after a tab", `proxy\taoc_${hex}`],
    ["after a carriage return", `proxy\raoc_${hex}`],
    ["after a quote", `url="aoc_${hex}"`],
    ["at the very start", `aoc_${hex} rejected`],
  ])(
    "a token %s never reaches stderr (the serialized-line blind spot)",
    (_case, text) => {
      const lines = captured();
      log("error", text, { reason: text, nested: { deep: [text] } });
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(hex);
      expect(lines[0]).toContain("aoc_[REDACTED]");
      // Still one parseable JSON line.
      expect(() => JSON.parse(lines[0]!)).not.toThrow();
    },
  );
});
