import { beforeAll, describe, expect, it, vi } from "vitest";

// Non-cloud so the signing key may come from SECRET_ENCRYPTION_KEY, and pin the
// key so signatures are stable across the file.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "oss";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  delete process.env.OAUTH_STATE_SECRET;
});

import {
  generateNonce,
  signOAuthState,
  verifyOAuthState,
  type OAuthStatePayload,
} from "./oauth-state";

/** Re-wrap a decoded envelope, so a test can alter one half and re-encode. */
const reencode = (envelope: { data: unknown; sig: string }) =>
  Buffer.from(JSON.stringify(envelope)).toString("base64url");

const decode = (state: string) =>
  JSON.parse(Buffer.from(state, "base64url").toString()) as {
    data: OAuthStatePayload;
    sig: string;
  };

describe("oauth state", () => {
  let nonce: string;

  beforeAll(() => {
    nonce = generateNonce();
  });

  it("round trips a payload", () => {
    const payload = { projectId: "p1", provider: "gmail", nonce };
    expect(verifyOAuthState(signOAuthState(payload))).toEqual(payload);
  });

  // The extension point this change relies on: the payload carries arbitrary
  // extra keys (origin, connectionId, agentName, …) through the signature.
  it("carries unknown keys through the signature", () => {
    const payload = {
      projectId: "p1",
      provider: "gmail",
      nonce,
      origin: "https://onecli.example.com",
      agentName: "my-agent",
    };
    expect(verifyOAuthState(signOAuthState(payload))).toEqual(payload);
  });

  // The compatibility case that matters on deploy: states minted by a release
  // that predates `origin` are still in flight and must keep verifying.
  it("verifies a state that carries no origin", () => {
    const verified = verifyOAuthState(
      signOAuthState({ projectId: "p1", provider: "gmail", nonce }),
    );
    expect(verified).not.toBeNull();
    expect(verified?.origin).toBeUndefined();
  });

  it("rejects a tampered payload", () => {
    const envelope = decode(
      signOAuthState({
        projectId: "p1",
        provider: "gmail",
        nonce,
        origin: "https://onecli.example.com",
      }),
    );
    // Repoint the origin while keeping the original signature.
    const tampered = reencode({
      data: { ...envelope.data, origin: "https://evil.example.com" },
      sig: envelope.sig,
    });
    expect(verifyOAuthState(tampered)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const envelope = decode(
      signOAuthState({ projectId: "p1", provider: "gmail", nonce }),
    );
    const flipped = envelope.sig.startsWith("a")
      ? `b${envelope.sig.slice(1)}`
      : `a${envelope.sig.slice(1)}`;
    expect(
      verifyOAuthState(reencode({ ...envelope, sig: flipped })),
    ).toBeNull();
  });

  it("rejects a signature of the wrong length without throwing", () => {
    const envelope = decode(
      signOAuthState({ projectId: "p1", provider: "gmail", nonce }),
    );
    expect(
      verifyOAuthState(reencode({ ...envelope, sig: "short" })),
    ).toBeNull();
  });

  it("rejects malformed input", () => {
    for (const bad of [
      "",
      "not-base64url!!",
      Buffer.from("{}").toString("base64url"),
    ]) {
      expect(verifyOAuthState(bad)).toBeNull();
    }
  });

  it("mints distinct nonces", () => {
    expect(generateNonce()).not.toBe(generateNonce());
    expect(generateNonce()).toMatch(/^[0-9a-f]{32}$/);
  });
});
