import { describe, expect, it } from "vitest";
import { hostMatches } from "./path-match";
// Shared corpus: the SAME (host, pattern) pairs are asserted in the Rust port
// (crates/common/src/util.rs). A divergence means the gateway enforces
// something other than what the API believes it granted.
const CASES: ReadonlyArray<readonly [string, string, boolean]> = [
  ["example.s3.us-east-1.amazonaws.com", "*.s3.*.amazonaws.com", true],
  ["my-bucket.s3.eu-west-2.amazonaws.com", "*.s3.*.amazonaws.com", true],
  ["123456789012.ddb.us-east-1.amazonaws.com", "*.ddb.*.amazonaws.com", true],
  ["EXAMPLE.S3.US-EAST-1.AMAZONAWS.COM", "*.s3.*.amazonaws.com", true],
  ["a.b.s3.us-east-1.amazonaws.com", "*.s3.*.amazonaws.com", false],
  ["s3.us-east-1.amazonaws.com", "*.s3.*.amazonaws.com", false],
  ["s3tables.us-east-1.amazonaws.com", "*.s3.*.amazonaws.com", false],
  ["x.s3.y.amazonaws.com.evil.test", "*.s3.*.amazonaws.com", false],
  [".s3.x.amazonaws.com", "*.s3.*.amazonaws.com", false],
  ["s3..amazonaws.com", "*.s3.*.amazonaws.com", false],
  ["a.example.com", "**.example.com", false],
  // regime 1 — must be untouched
  ["a.b.example.com", "*.example.com", true],
  ["s3.dualstack.us-east-1.amazonaws.com", "s3.*.amazonaws.com", true],
  ["anything.at.all", "*", true],
  ["example.com", "*.example.com", false],
  [
    "us-central1-aiplatform.googleapis.com",
    "*-aiplatform.googleapis.com",
    true,
  ],
];
describe("hostMatches parity corpus (mirrored in the Rust port)", () => {
  it.each(CASES)("%s vs %s", (host, pattern, want) => {
    expect(hostMatches(host, pattern)).toBe(want);
  });
});
