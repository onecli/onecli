import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

import { WireReader, WireWriter } from "./wire";

export const ED25519_KEY_TYPE = "ssh-ed25519";
export const ED25519_RAW_KEY_LENGTH = 32;
export const ED25519_SIGNATURE_LENGTH = 64;

/**
 * DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410): the 32 raw key
 * bytes always sit at the tail of a fixed 44-byte structure. Used both to
 * lift KMS GetPublicKey output into SSH wire format and to hand raw SSH keys
 * to node:crypto (which only speaks DER/PEM).
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** SSH wire public-key blob: `string "ssh-ed25519"` + `string raw32`. */
export const ed25519KeyBlob = (raw: Buffer): Buffer => {
  if (raw.length !== ED25519_RAW_KEY_LENGTH) {
    throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  }
  return new WireWriter()
    .writeString(ED25519_KEY_TYPE)
    .writeString(raw)
    .toBuffer();
};

/** Parse an SSH wire public-key blob; refuses every type but ssh-ed25519. */
export const parseEd25519KeyBlob = (blob: Buffer): Buffer => {
  const reader = new WireReader(blob);
  const type = reader.readString().toString("utf8");
  if (type !== ED25519_KEY_TYPE) {
    throw new Error(`unsupported key type ${type} (only ${ED25519_KEY_TYPE})`);
  }
  const raw = reader.readString();
  reader.expectEnd();
  if (raw.length !== ED25519_RAW_KEY_LENGTH) {
    throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  }
  return Buffer.from(raw);
};

/**
 * Parse an authorized_keys-style line ("ssh-ed25519 AAAA… [comment]") into
 * the raw 32-byte key. The line's base64 blob must round-trip to exactly the
 * declared type — a mismatch is a malformed or non-ed25519 key, refused.
 */
export const parseEd25519PublicKeyLine = (line: string): Buffer => {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== ED25519_KEY_TYPE) {
    throw new Error(
      `expected an "${ED25519_KEY_TYPE} <base64>" public key line`,
    );
  }
  const blob = Buffer.from(parts[1] ?? "", "base64");
  if (blob.length === 0) throw new Error("empty public key material");
  return parseEd25519KeyBlob(blob);
};

/** Render a raw 32-byte key as an authorized_keys-style line. */
export const formatEd25519PublicKeyLine = (
  raw: Buffer,
  comment?: string,
): string => {
  const base = `${ED25519_KEY_TYPE} ${ed25519KeyBlob(raw).toString("base64")}`;
  return comment ? `${base} ${comment}` : base;
};

/**
 * OpenSSH-style SHA256 fingerprint of an ed25519 public key
 * ("SHA256:<base64, no padding>") — byte-identical to `ssh-keygen -lf`,
 * which hashes the wire blob, not the base64 line. The canonical identity
 * for display and dedupe: it must always be computed from parsed key
 * material, never accepted from a client.
 */
export const ed25519Fingerprint = (raw: Buffer): string =>
  `SHA256:${createHash("sha256")
    .update(ed25519KeyBlob(raw))
    .digest("base64")
    .replace(/=+$/, "")}`;

/** Lift a DER SubjectPublicKeyInfo (KMS GetPublicKey output) to the raw key. */
export const spkiToEd25519Raw = (der: Buffer): Buffer => {
  if (
    der.length !== ED25519_SPKI_PREFIX.length + ED25519_RAW_KEY_LENGTH ||
    !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new Error("not an Ed25519 SubjectPublicKeyInfo");
  }
  return Buffer.from(der.subarray(ED25519_SPKI_PREFIX.length));
};

const publicKeyObjectFromRaw = (raw: Buffer): KeyObject =>
  createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });

/** Pure-Ed25519 verify (data is signed raw, never pre-hashed). */
export const ed25519Verify = (
  raw: Buffer,
  data: Buffer,
  signature: Buffer,
): boolean => {
  if (signature.length !== ED25519_SIGNATURE_LENGTH) return false;
  return cryptoVerify(null, data, publicKeyObjectFromRaw(raw), signature);
};

export interface Ed25519Signer {
  /** Raw 32-byte public key of the signing identity. */
  publicKey: Buffer;
  /** Pure-Ed25519 signature (64 bytes) over the exact input. */
  sign: (data: Buffer) => Promise<Buffer>;
}

/**
 * In-process signer from a PKCS#8 PEM private key — the onprem default and
 * the test harness; the cloud twin wraps KMS Sign behind the same shape.
 */
export const ed25519SignerFromPrivateKeyPem = (pem: string): Ed25519Signer => {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `SSH CA private key must be ed25519, got ${privateKey.asymmetricKeyType ?? "unknown"}`,
    );
  }
  const spki = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  const publicKey = spkiToEd25519Raw(Buffer.from(spki));
  return {
    publicKey,
    sign: (data) => Promise.resolve(cryptoSign(null, data, privateKey)),
  };
};
