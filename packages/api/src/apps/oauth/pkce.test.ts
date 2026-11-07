import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
});

import { pkceChallenge, pkceVerifier } from "./pkce";

describe("pkce", () => {
  it("derives the same verifier for a state on every call, and a new one per state", async () => {
    const a = await pkceVerifier("state-a");
    expect(await pkceVerifier("state-a")).toBe(a);
    expect(await pkceVerifier("state-b")).not.toBe(a);
    // RFC 7636: 43-128 unreserved characters.
    expect(a).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
  });

  it("computes the RFC 7636 S256 challenge", async () => {
    // RFC 7636 Appendix B test vector.
    expect(
      await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
