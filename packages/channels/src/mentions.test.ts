import { describe, expect, it } from "vitest";
import {
  MAX_MENTION_TOKENS,
  mentionNamesOf,
  normalizeMentionName,
  plainMentionCandidatesOf,
  replaceMentionTokens,
  scanMentionTokens,
} from "./mentions";

describe("scanMentionTokens", () => {
  it("finds @[Name] tokens with exact spans", () => {
    const text = "ask @[Dan Abramov] and @[Kelly] about it";
    const tokens = scanMentionTokens(text);
    expect(tokens).toEqual([
      { name: "Dan Abramov", start: 4, end: 18 },
      { name: "Kelly", start: 23, end: 31 },
    ]);
    // Spans must slice back to the tokens themselves — the renderer
    // replaces by span, so an off-by-one would corrupt the message.
    expect(text.slice(tokens[0]!.start, tokens[0]!.end)).toBe("@[Dan Abramov]");
    expect(text.slice(tokens[1]!.start, tokens[1]!.end)).toBe("@[Kelly]");
  });

  it("skips blank and over-long names as literal text", () => {
    expect(scanMentionTokens("hi @[] there")).toEqual([]);
    expect(scanMentionTokens("hi @[   ] there")).toEqual([]);
    expect(scanMentionTokens(`hi @[${"x".repeat(81)}] there`)).toEqual([]);
  });

  it("a name never spans a newline (one line rule)", () => {
    expect(scanMentionTokens("hi @[Dan\nAbramov]")).toEqual([]);
  });

  it("no nesting: the first ] closes the token", () => {
    const tokens = scanMentionTokens("@[Dan [the man]]");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.name).toBe("Dan [the man");
  });

  it("plain @Name and markdown links are not tokens", () => {
    expect(scanMentionTokens("hi @Dan, see [docs](https://x.com)")).toEqual([]);
  });

  it("caps at MAX_MENTION_TOKENS - a mention flood stays literal past the cap", () => {
    const flood = Array.from({ length: 30 }, (_, i) => `@[User ${i}]`).join(
      " ",
    );
    expect(scanMentionTokens(flood)).toHaveLength(MAX_MENTION_TOKENS);
  });
});

describe("normalizeMentionName", () => {
  it("trims, collapses whitespace, case-folds", () => {
    expect(normalizeMentionName("  Dan   Abramov ")).toBe("dan abramov");
    expect(normalizeMentionName("KELLY")).toBe("kelly");
  });

  it("never makes 'Dan' equal 'Dan Abramov' (exact, not prefix)", () => {
    expect(normalizeMentionName("Dan")).not.toBe(
      normalizeMentionName("Dan Abramov"),
    );
  });
});

describe("replaceMentionTokens", () => {
  it("rewrites tokens through the callback and leaves blank/over-long literal", () => {
    const out = replaceMentionTokens(
      `hi @[Dan], @[] and @[${"x".repeat(81)}]`,
      (name) => `<${name}>`,
    );
    expect(out).toBe(`hi <Dan>, @[] and @[${"x".repeat(81)}]`);
  });

  it("returning the token unchanged keeps it literal", () => {
    expect(replaceMentionTokens("hi @[Dan]", (_n, token) => token)).toBe(
      "hi @[Dan]",
    );
  });
});

describe("mentionNamesOf", () => {
  it("dedupes by normalized name", () => {
    expect(mentionNamesOf("@[Dan] then @[DAN] then @[ dan ]")).toEqual(["dan"]);
  });
});

describe("plainMentionCandidatesOf", () => {
  it("offers word-prefixes of a plain @run, longest first, normalized", () => {
    expect(plainMentionCandidatesOf("thanks @Dan Abramov said so")).toEqual([
      "dan abramov said",
      "dan abramov",
      "dan",
    ]);
  });

  it("skips the real grammar and emails", () => {
    expect(plainMentionCandidatesOf("hi @[Dan] and dan@example.com")).toEqual(
      [],
    );
  });

  it("stops at punctuation and caps the set", () => {
    expect(plainMentionCandidatesOf("hey @guy, how are you")).toEqual(["guy"]);
    const flood = Array.from({ length: 40 }, (_, i) => `@n${i}`).join(" ");
    expect(plainMentionCandidatesOf(flood).length).toBeLessThanOrEqual(20);
  });
});
