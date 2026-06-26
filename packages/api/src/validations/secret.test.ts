import { describe, expect, it } from "vitest";

import { hostPatternSchema, wildcardCoversPublicSuffix } from "./secret";

const accepts = (host: string) => hostPatternSchema.safeParse(host).success;

// Unicode whitespace that String.prototype.trim() strips but that is NOT the
// ASCII space the schema rejects: a non-breaking space and an ideographic space.
const NBSP = String.fromCharCode(0xa0);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

describe("secret host pattern validation", () => {
  // Exact hosts, and a wildcard over a single registrable domain, are fine.
  it.each([
    "api.github.com",
    "*.example.com",
    "*.amazonaws.com",
    "*.internal", // unknown/custom TLD — left to the operator
  ])("accepts %s", (host) => {
    expect(accepts(host)).toBe(true);
  });

  // A wildcard that spans a public suffix would inject the credential across
  // many unrelated owners — ICANN suffixes and PSL private-section (per-tenant)
  // suffixes alike — so it is rejected.
  it.each(["*.com", "*.io", "*.co.uk", "*.s3.amazonaws.com", "*.github.io"])(
    "rejects public-suffix wildcard %s",
    (host) => {
      expect(accepts(host)).toBe(false);
    },
  );

  // Validation runs on the trimmed value (the service trims on save), so
  // trailing Unicode whitespace must not smuggle a public-suffix wildcard past
  // the check, nor reject an otherwise-valid pattern.
  it("validates the trimmed host pattern", () => {
    expect(accepts("*.com" + NBSP)).toBe(false); // trims to "*.com"
    expect(accepts("*.s3.amazonaws.com" + IDEOGRAPHIC_SPACE)).toBe(false);
    expect(accepts("*.example.com" + NBSP)).toBe(true); // trims to "*.example.com"
  });

  // Malformed wildcard shapes stay rejected (bare, mid-string, multiple).
  it.each(["*", "api.*.com", "*.*.com"])(
    "rejects malformed wildcard %s",
    (host) => {
      expect(accepts(host)).toBe(false);
    },
  );
});

describe("wildcardCoversPublicSuffix", () => {
  it("is true only for a wildcard spanning a public suffix", () => {
    expect(wildcardCoversPublicSuffix("*.com")).toBe(true);
    expect(wildcardCoversPublicSuffix("*.s3.amazonaws.com")).toBe(true);
    expect(wildcardCoversPublicSuffix("*.example.com")).toBe(false);
    expect(wildcardCoversPublicSuffix("*.amazonaws.com")).toBe(false);
    expect(wildcardCoversPublicSuffix("api.github.com")).toBe(false);
  });
});
