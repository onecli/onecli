import { describe, expect, it } from "vitest";
import { hostMatches, isLlmHost, pathMatches } from "./path-match";

// Fidelity cases mirrored from apps/gateway/src/inject.rs + connect.rs. If any
// of these break, the port has drifted from the gateway's matcher.

describe("pathMatches", () => {
  it('"*" matches anything', () => {
    expect(pathMatches("/anything/here", "*")).toBe(true);
    expect(pathMatches("", "*")).toBe(true);
  });

  it('"/p/*" is a prefix WITH a "/" boundary and matches the bare prefix', () => {
    expect(pathMatches("/v1/foo", "/v1/*")).toBe(true);
    expect(pathMatches("/v1/foo/bar", "/v1/*")).toBe(true); // unlimited depth
    expect(pathMatches("/v1", "/v1/*")).toBe(true); // bare prefix
    expect(pathMatches("/v1beta", "/v1/*")).toBe(false); // boundary required
    expect(pathMatches("/gmail/v1/x", "/gmail/*")).toBe(true);
    expect(pathMatches("/gmailx", "/gmail/*")).toBe(false);
  });

  it('"/p*" is a raw prefix, no boundary', () => {
    expect(pathMatches("/v1.0/me/messages/123", "/v1.0/me/messages*")).toBe(
      true,
    );
    expect(pathMatches("/v1.0/me/messagesX", "/v1.0/me/messages*")).toBe(true);
    expect(pathMatches("/v1.0/me/other", "/v1.0/me/messages*")).toBe(false);
  });

  it("mid-path segment globs never cross /", () => {
    expect(
      pathMatches("/v1/proj/models/ep123:predict", "/v1/*/models/*:predict"),
    ).toBe(true);
    expect(
      pathMatches("/v1/a/b/models/x:predict", "/v1/*/models/*:predict"),
    ).toBe(
      false, // "*" is one segment, can't span a/b
    );
    expect(
      pathMatches("/v1/proj/models/x:other", "/v1/*/models/*:predict"),
    ).toBe(false);
  });

  it("trailing standalone * (in a segment pattern) matches 1+ segments, not zero", () => {
    expect(pathMatches("/v1/p/data/x", "/v1/*/data/*")).toBe(true);
    expect(pathMatches("/v1/p/data/x/y", "/v1/*/data/*")).toBe(true);
    expect(pathMatches("/v1/p/data", "/v1/*/data/*")).toBe(false);
  });

  it("exact match otherwise, and query strings are stripped", () => {
    expect(pathMatches("/exact", "/exact")).toBe(true);
    expect(pathMatches("/exact/x", "/exact")).toBe(false);
    expect(pathMatches("/p?service=git-receive-pack", "/p")).toBe(true);
  });
});

describe("hostMatches", () => {
  it("exact, case-insensitive", () => {
    expect(hostMatches("gmail.googleapis.com", "gmail.googleapis.com")).toBe(
      true,
    );
    expect(hostMatches("GMAIL.googleapis.com", "gmail.googleapis.com")).toBe(
      true,
    );
    expect(hostMatches("other.com", "gmail.googleapis.com")).toBe(false);
  });

  it("single * with the length guard (apex + too-short excluded)", () => {
    expect(hostMatches("api.example.com", "*.example.com")).toBe(true);
    expect(hostMatches("example.com", "*.example.com")).toBe(false); // apex too short
    expect(
      hostMatches("s3.us-east-1.amazonaws.com", "s3.*.amazonaws.com"),
    ).toBe(true);
    // Missing the middle region → shorter than prefix+suffix → excluded.
    expect(hostMatches("s3.amazonaws.com", "s3.*.amazonaws.com")).toBe(false);
  });
});

describe("isLlmHost", () => {
  it("matches known LLM providers (port stripped)", () => {
    expect(isLlmHost("api.anthropic.com")).toBe(true);
    expect(isLlmHost("api.openai.com:443")).toBe(true);
    expect(isLlmHost("generativelanguage.googleapis.com")).toBe(true);
    expect(isLlmHost("gmail.googleapis.com")).toBe(false);
  });
});
