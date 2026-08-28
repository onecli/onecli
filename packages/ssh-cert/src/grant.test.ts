import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { signGrant, verifyGrant } from "./grant";
import { ed25519SignerFromPrivateKeyPem } from "./keys";

const newSigner = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return ed25519SignerFromPrivateKeyPem(
    privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  );
};

const ca = newSigner();

const grant = {
  sessionId: "sess_1",
  agentId: "agent_1",
  sandboxId: "sbx_1",
  workspaceId: "ws_1",
  expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
};

describe("session grant", () => {
  it("round-trips and verifies", async () => {
    const encoded = await signGrant(grant, ca);
    expect(verifyGrant(encoded, ca.publicKey)).toEqual(grant);
  });

  it("rejects a foreign signer", async () => {
    const encoded = await signGrant(grant, newSigner());
    expect(() => verifyGrant(encoded, ca.publicKey)).toThrow(
      expect.objectContaining({ reason: "bad_signature" }),
    );
  });

  it("rejects tampering (swapped sandbox id)", async () => {
    const encoded = await signGrant(grant, ca);
    const blob = Buffer.from(encoded, "base64");
    const idx = blob.indexOf(Buffer.from("sbx_1", "utf8"));
    blob[idx] = (blob[idx] ?? 0) ^ 0xff;
    expect(() => verifyGrant(blob.toString("base64"), ca.publicKey)).toThrow(
      expect.objectContaining({ reason: "bad_signature" }),
    );
  });

  it("rejects an expired grant", async () => {
    const encoded = await signGrant(
      { ...grant, expiresAt: BigInt(Math.floor(Date.now() / 1000) - 1) },
      ca,
    );
    expect(() => verifyGrant(encoded, ca.publicKey)).toThrow(
      expect.objectContaining({ reason: "expired" }),
    );
  });

  it("rejects garbage", () => {
    expect(() => verifyGrant("not-base64!!", ca.publicKey)).toThrow(
      expect.objectContaining({ reason: "malformed" }),
    );
  });
});
