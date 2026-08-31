import { describe, expect, it } from "vitest";
import { hostMatches } from "./path-match";
// SECURITY: the new regime must never be a WIDENING for any pattern shape that
// could already exist. A 2+-star pattern matched NOTHING before, so any match
// now is new reach — these pin that the new reach is confined to the exact
// label structure the pattern spells out, and never escapes it.
describe("multi-wildcard cannot escape its stated structure", () => {
  const P = "*.s3.*.amazonaws.com";
  it("never matches a different registrable domain", () => {
    for (const h of [
      "x.s3.y.amazonaws.com.evil.test", // suffix append
      "evil.test.s3.y.amazonaws.com.co", // different TLD
      "x.s3.y.amazonaws.co", // truncated TLD
      "x.s3.y.amazonaws.comX", // TLD extension
    ])
      expect(hostMatches(h, P), h).toBe(false);
  });
  it("never crosses a label boundary", () => {
    for (const h of [
      "a.b.s3.us-east-1.amazonaws.com", // deeper
      "s3.us-east-1.amazonaws.com", // shallower
      "xs3.us-east-1.amazonaws.com", // label merge
    ])
      expect(hostMatches(h, P), h).toBe(false);
  });
  it("never matches a sibling AWS service", () => {
    for (const h of [
      "b.s3tables.r.amazonaws.com",
      "b.s3-control.r.amazonaws.com",
      "b.ec2.r.amazonaws.com",
    ])
      expect(hostMatches(h, P), h).toBe(false);
  });
  it("rejects empty and whitespace-ish labels", () => {
    for (const h of [
      "..s3.x.amazonaws.com",
      ".s3.x.amazonaws.com",
      "x.s3..amazonaws.com",
    ])
      expect(hostMatches(h, P), h).toBe(false);
  });
  it("is case-insensitive in ASCII only (matches the Rust port)", () => {
    expect(hostMatches("B.S3.R.AMAZONAWS.COM", P)).toBe(true);
    // Unicode dotted-I must NOT fold into ASCII 'i' (JS toLowerCase would).
    expect(
      hostMatches("b.s\u0130.r.amazonaws.com", "*.si.*.amazonaws.com"),
    ).toBe(false);
  });
});
