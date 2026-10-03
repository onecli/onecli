import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pathMatches } from "./path-match";

// Shared corpus: the SAME (path, pattern) pairs are asserted in the Rust port
// (apps/gateway/crates/inject/src/lib.rs, `include_str!`). A divergence means
// the gateway enforces something other than what the API believes it granted.
const CORPUS = fileURLToPath(
  new URL("./path-match-cases.json", import.meta.url),
);

const { cases } = JSON.parse(readFileSync(CORPUS, "utf8")) as {
  cases: { path: string; pattern: string; want: boolean }[];
};

describe("pathMatches parity corpus (mirrored in the Rust port)", () => {
  it("is not empty", () => {
    expect(cases.length).toBeGreaterThan(20);
  });

  it.each(cases)("$path vs $pattern → $want", ({ path, pattern, want }) => {
    expect(pathMatches(path, pattern)).toBe(want);
  });
});
