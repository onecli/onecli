import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySvixSignature, webhookSecretsFrom } from "./webhook-signature";

// Fixture vectors computed with the same primitives the verifier documents
// (svix manual verification): sign `${id}.${timestamp}.${body}` with the
// base64-decoded secret, emit base64. A test-only signer is the positive
// control — every negative below differs from a KNOWN-GOOD input by exactly
// one field, so a pass can only mean the check for that field is alive.

const SECRET = `whsec_${Buffer.from("test-signing-key-32-bytes-long!!").toString("base64")}`;
const BODY = JSON.stringify({
  type: "email.delivered",
  data: { to: ["a@b.c"] },
});
const NOW_MS = 1_700_000_000_000;
const TIMESTAMP = String(Math.floor(NOW_MS / 1000));
const ID = "msg_fixture";

const sign = (id: string, timestamp: string, body: string, secret = SECRET) =>
  createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");

const valid = () => ({
  secrets: [SECRET],
  id: ID,
  timestamp: TIMESTAMP,
  signature: `v1,${sign(ID, TIMESTAMP, BODY)}`,
  body: BODY,
  nowMs: NOW_MS,
});

describe("verifySvixSignature", () => {
  // THE conformance anchor. Every other vector here is signed by the test's
  // own signer, which mirrors the implementation — so a shared
  // misunderstanding of the scheme (signed-content order, digest encoding,
  // whsec_ decoding) would keep them all green while production rejected
  // 100% of genuine webhooks. This vector is published by the scheme's
  // vendor, so it fails if our algorithm is wrong at all.
  it("accepts the PUBLISHED svix reference vector (external known-answer)", () => {
    expect(
      verifySvixSignature({
        secrets: ["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"],
        id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
        timestamp: "1614265330",
        signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
        body: '{"test": 2432232314}',
        // The reference timestamp is historical — pin the clock to it so the
        // tolerance window is not what this test is measuring.
        nowMs: 1614265330 * 1000,
      }),
    ).toBe(true);
  });

  it("accepts the valid vector", () => {
    expect(verifySvixSignature(valid())).toBe(true);
  });

  it("accepts when the matching v1 entry sits among others (space-separated list)", () => {
    const good = sign(ID, TIMESTAMP, BODY);
    expect(
      verifySvixSignature({
        ...valid(),
        signature: `v1,${Buffer.from("wrong-signature-entry-padding!!!").toString("base64")} v1,${good}`,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifySvixSignature({ ...valid(), body: `${BODY} ` })).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const otherSecret = `whsec_${Buffer.from("another-signing-key-32-bytes!!!!").toString("base64")}`;
    expect(
      verifySvixSignature({
        ...valid(),
        signature: `v1,${sign(ID, TIMESTAMP, BODY, otherSecret)}`,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay window)", () => {
    const stale = String(Math.floor(NOW_MS / 1000) - 6 * 60);
    expect(
      verifySvixSignature({
        ...valid(),
        timestamp: stale,
        signature: `v1,${sign(ID, stale, BODY)}`,
      }),
    ).toBe(false);
  });

  it("rejects a future timestamp beyond the window", () => {
    const future = String(Math.floor(NOW_MS / 1000) + 6 * 60);
    expect(
      verifySvixSignature({
        ...valid(),
        timestamp: future,
        signature: `v1,${sign(ID, future, BODY)}`,
      }),
    ).toBe(false);
  });

  it("rejects missing or malformed headers", () => {
    expect(verifySvixSignature({ ...valid(), id: undefined })).toBe(false);
    expect(verifySvixSignature({ ...valid(), timestamp: "not-a-number" })).toBe(
      false,
    );
    expect(verifySvixSignature({ ...valid(), signature: undefined })).toBe(
      false,
    );
    expect(
      verifySvixSignature({ ...valid(), signature: "v2,unknown-version" }),
    ).toBe(false);
    expect(verifySvixSignature({ ...valid(), signature: "garbage" })).toBe(
      false,
    );
  });

  it("rejects an empty secret", () => {
    expect(verifySvixSignature({ ...valid(), secrets: [] })).toBe(false);
    expect(verifySvixSignature({ ...valid(), secrets: ["whsec_"] })).toBe(
      false,
    );
  });

  // A provider issues one secret per endpoint, and svix keeps the previous
  // secret valid during a rotation — so a candidate LIST is the shape, and
  // any member matching accepts.
  it("accepts when the signing secret is one of several candidates (rotation)", () => {
    const other = `whsec_${Buffer.from("rotation-era-old-key-32-bytes!!!!").toString("base64")}`;
    expect(verifySvixSignature({ ...valid(), secrets: [other, SECRET] })).toBe(
      true,
    );
    // …and a list of only WRONG secrets still refuses.
    expect(verifySvixSignature({ ...valid(), secrets: [other] })).toBe(false);
  });
});

describe("webhookSecretsFrom", () => {
  it("splits a configured value on whitespace and commas, dropping empties", () => {
    expect(webhookSecretsFrom("whsec_a,whsec_b")).toEqual([
      "whsec_a",
      "whsec_b",
    ]);
    expect(webhookSecretsFrom(" whsec_a   whsec_b ")).toEqual([
      "whsec_a",
      "whsec_b",
    ]);
    expect(webhookSecretsFrom("whsec_a, ,whsec_b")).toEqual([
      "whsec_a",
      "whsec_b",
    ]);
  });

  it("an unset or blank value yields NO candidates — the fail-closed input", () => {
    expect(webhookSecretsFrom(undefined)).toEqual([]);
    expect(webhookSecretsFrom("")).toEqual([]);
    expect(webhookSecretsFrom("   ")).toEqual([]);
  });
});
