import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  buildUserCertificate,
  ed25519SignerFromPrivateKeyPem,
  spkiToEd25519Raw,
  type BuildUserCertificateOptions,
  type BuiltCertificate,
  type Ed25519Signer,
} from "@onecli/ssh-cert";

/** Shared cert-minting helpers for the terminator's test suites. */

export interface TestCa {
  signer: Ed25519Signer;
  /** Raw 32-byte public key — the trust anchor under test. */
  publicKey: Buffer;
}

export const createTestCa = (): TestCa => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const signer = ed25519SignerFromPrivateKeyPem(
    typeof pem === "string" ? pem : pem.toString("utf8"),
  );
  return { signer, publicKey: signer.publicKey };
};

export interface TestUserKey {
  /** Raw 32-byte public key. */
  publicKey: Buffer;
  /** Pure-ed25519 signature over the exact input (possession proofs). */
  sign(data: Buffer): Buffer;
}

export const createTestUserKey = (): TestUserKey => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKey: spkiToEd25519Raw(Buffer.from(spki)),
    sign: (data) => cryptoSign(null, data, privateKey),
  };
};

export const mintTestCertificate = (
  ca: TestCa,
  user: TestUserKey,
  overrides: Partial<BuildUserCertificateOptions> = {},
): Promise<BuiltCertificate> =>
  buildUserCertificate(
    {
      userPublicKey: user.publicKey,
      keyId: JSON.stringify({
        u: "user-1",
        e: "u@example.com",
        a: "agent-1",
        w: "ws-1",
      }),
      principal: "agent-1",
      validAfter: new Date(Date.now() - 60_000),
      validBefore: new Date(Date.now() + 600_000),
      sandboxId: "sbx-1",
      workspaceId: "ws-1",
      userId: "user-1",
      ...overrides,
    },
    ca.signer,
  );
