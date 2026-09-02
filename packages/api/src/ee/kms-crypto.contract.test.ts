import { createDecipheriv, createCipheriv, randomBytes } from "crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
} from "@aws-sdk/client-kms";

/**
 * The TS half of the TS↔Rust KMS envelope contract.
 *
 * TypeScript writes the 4-part envelope (`ee/kms-crypto.ts` at secret
 * creation); the Rust gateway decrypts it (`apps/gateway/src/ee/kms_crypto.rs`
 * on the request path). Neither can import the other, so the contract is a
 * committed fixture both sides must open: `kms-envelope.fixture.json` here,
 * `include_str!`-ed by the Rust twin (the corpus-test pattern).
 *
 * This used to be guarded only by the gateway E2E suite against a KMS
 * emulator; the E2E lane now runs the enterprise edition (local AES), so this
 * pair of unit tests is the contract's permanent home. What is deliberately
 * NOT covered here: the live KMS GenerateDataKey/Decrypt round-trip — AWS SDK
 * mechanics proven by cloud deploys.
 */

interface EnvelopeFixture {
  readonly dataKeyB64: string;
  readonly encryptedDataKeyB64: string;
  readonly encryptionContextKey: string;
  readonly encryptionContextValue: string;
  readonly plaintext: string;
  readonly envelope: string;
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "kms-envelope.fixture.json"), "utf8"),
) as EnvelopeFixture;

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** Open a 4-part envelope with a raw data key — the algorithm the Rust
 * gateway applies after KMS Decrypt returns the data key. */
const openEnvelope = (envelope: string, dataKey: Buffer): string => {
  const parts = envelope.split(":");
  expect(parts).toHaveLength(4);
  const [, ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64!, "base64");
  const authTag = Buffer.from(authTagB64!, "base64");
  expect(iv).toHaveLength(IV_LENGTH);
  expect(authTag).toHaveLength(AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, dataKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64!, "base64")),
    decipher.final(),
  ]).toString("utf8");
};

describe("the committed envelope fixture", () => {
  it("opens with the fixture data key to the fixture plaintext", () => {
    const dataKey = Buffer.from(fixture.dataKeyB64, "base64");
    expect(dataKey).toHaveLength(32);
    expect(openEnvelope(fixture.envelope, dataKey)).toBe(fixture.plaintext);
  });

  it("carries the encrypted data key as its first part", () => {
    const [edkB64] = fixture.envelope.split(":");
    expect(edkB64).toBe(fixture.encryptedDataKeyB64);
  });

  it("does not open with a different key (positive control)", () => {
    // Proves the pair of contract tests would actually detonate on drift:
    // a mutated fixture or a changed algorithm fails, never passes vacuously.
    expect(() => openEnvelope(fixture.envelope, randomBytes(32))).toThrow();
  });
});

describe("the production encryptor (ee/kms-crypto.ts)", () => {
  beforeEach(() => {
    vi.stubEnv("KMS_KEY_ARN", "arn:aws:kms:us-east-1:000000000000:key/test");
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("writes an envelope the fixture algorithm opens, with the pinned encryption context", async () => {
    const dataKey = Buffer.from(fixture.dataKeyB64, "base64");
    const encryptedDataKey = Buffer.from(fixture.encryptedDataKeyB64, "base64");

    // Stub only the network: GenerateDataKey hands back the fixture data key,
    // exactly what a real KMS does. Everything after that — the AES-GCM seal,
    // the part order, the base64 joins — is the real production code.
    const contexts: Array<Record<string, string> | undefined> = [];
    const sendSpy = vi
      .spyOn(KMSClient.prototype, "send")
      .mockImplementation((command: unknown) => {
        if (command instanceof GenerateDataKeyCommand) {
          contexts.push(command.input.EncryptionContext);
          return Promise.resolve({
            Plaintext: new Uint8Array(dataKey),
            CiphertextBlob: new Uint8Array(encryptedDataKey),
          });
        }
        if (command instanceof DecryptCommand) {
          contexts.push(command.input.EncryptionContext);
          return Promise.resolve({ Plaintext: new Uint8Array(dataKey) });
        }
        throw new Error("unexpected KMS command");
      });

    // Import AFTER the env stub: KMS_KEY_ARN resolves at module load.
    const { cryptoService } = await import("./kms-crypto");

    const envelope = await cryptoService.encrypt(fixture.plaintext);
    expect(openEnvelope(envelope, dataKey)).toBe(fixture.plaintext);

    // And the decrypt path opens the COMMITTED envelope — the exact bytes the
    // Rust twin opens.
    expect(await cryptoService.decrypt(fixture.envelope)).toBe(
      fixture.plaintext,
    );

    // The encryption context is part of the contract: the Rust decryptor
    // sends the same pair, and KMS refuses a mismatch.
    expect(sendSpy).toHaveBeenCalledTimes(2);
    for (const context of contexts) {
      expect(context).toEqual({
        [fixture.encryptionContextKey]: fixture.encryptionContextValue,
      });
    }
  });

  it("refuses the 3-part local-AES format with the re-create guidance", async () => {
    const { cryptoService } = await import("./kms-crypto");
    const key = randomBytes(32);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const enc = Buffer.concat([cipher.update("v", "utf8"), cipher.final()]);
    const threePart = [
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      enc.toString("base64"),
    ].join(":");
    await expect(cryptoService.decrypt(threePart)).rejects.toThrow(
      /legacy encryption format/,
    );
  });
});
