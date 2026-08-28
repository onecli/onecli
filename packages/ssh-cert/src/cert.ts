import { randomBytes } from "node:crypto";

import {
  ED25519_SIGNATURE_LENGTH,
  ed25519KeyBlob,
  ed25519Verify,
  parseEd25519KeyBlob,
  type Ed25519Signer,
} from "./keys";
import { readPackedStrings, WireReader, WireWriter } from "./wire";

/**
 * OpenSSH user certificates (PROTOCOL.certkeys), ed25519-only by design:
 * the interop-proven algorithm end to end (ssh2's server never advertises
 * server-sig-algs, which makes the rsa-sha2-*-cert path fragile), one
 * signature scheme, no DER/mpint conversions anywhere.
 */

export const ED25519_CERT_TYPE = "ssh-ed25519-cert-v01@openssh.com";
export const SSH_CERT_TYPE_USER = 1;

/** The OneCLI-signed identity extensions carried inside every minted cert. */
export const CERT_EXT_SANDBOX_ID = "sandbox-id@onecli.sh";
export const CERT_EXT_WORKSPACE_ID = "workspace-id@onecli.sh";
export const CERT_EXT_USER_ID = "user-id@onecli.sh";
export const CERT_EXT_PERMIT_PTY = "permit-pty";

export interface SshCertificateField {
  name: string;
  data: Buffer;
}

export interface SshCertificate {
  /** Raw 32-byte user public key embedded in the certificate. */
  publicKey: Buffer;
  serial: bigint;
  certType: number;
  keyId: string;
  principals: string[];
  validAfter: bigint;
  validBefore: bigint;
  criticalOptions: SshCertificateField[];
  extensions: SshCertificateField[];
  /** SSH wire blob of the CA public key the cert claims to be signed by. */
  signatureKey: Buffer;
  /** Raw 64-byte ed25519 signature. */
  signature: Buffer;
  /** The signed span: every byte of the blob up to (excluding) the signature. */
  tbs: Buffer;
  /** The whole certificate blob. */
  raw: Buffer;
}

const packFields = (fields: SshCertificateField[]): Buffer => {
  const writer = new WireWriter();
  for (const field of fields)
    writer.writeString(field.name).writeString(field.data);
  return writer.toBuffer();
};

const unpackFields = (packed: Buffer): SshCertificateField[] => {
  const parts = readPackedStrings(packed);
  if (parts.length % 2 !== 0) throw new Error("odd option/extension packing");
  const out: SshCertificateField[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    out.push({
      name: (parts[i] as Buffer).toString("utf8"),
      data: Buffer.from(parts[i + 1] as Buffer),
    });
  }
  return out;
};

/** A valued extension's data is itself an SSH string (string-in-string). */
const packedValue = (value: string): Buffer =>
  new WireWriter().writeString(value).toBuffer();

const unpackValue = (data: Buffer): string => {
  const reader = new WireReader(data);
  const value = reader.readString().toString("utf8");
  reader.expectEnd();
  return value;
};

/** Read a valued OneCLI extension; null when absent. */
export const getExtensionValue = (
  cert: SshCertificate,
  name: string,
): string | null => {
  const field = cert.extensions.find((ext) => ext.name === name);
  if (!field) return null;
  return unpackValue(field.data);
};

export interface BuildUserCertificateOptions {
  /** Raw 32-byte ed25519 user public key (from the pasted public-key line). */
  userPublicKey: Buffer;
  /** Free-form audit label sshd-style tooling displays; compact JSON here. */
  keyId: string;
  /** The immutable agent id — the only principal ever minted. */
  principal: string;
  validAfter: Date;
  validBefore: Date;
  sandboxId: string;
  workspaceId: string;
  userId: string;
  serial?: bigint;
}

export interface BuiltCertificate {
  blob: Buffer;
  /** `ssh-ed25519-cert-v01@openssh.com <base64>` — what the user saves. */
  line: string;
  serial: bigint;
}

/**
 * Mint a user certificate. Extensions are written in lexical name order
 * (PROTOCOL.certkeys requires it; OpenSSH refuses out-of-order fields), and
 * no critical options are ever emitted — verifiers reject any they see.
 */
export const buildUserCertificate = async (
  opts: BuildUserCertificateOptions,
  signer: Ed25519Signer,
): Promise<BuiltCertificate> => {
  if (!opts.principal) throw new Error("certificate principal is required");
  // Random 63-bit serial: unique enough for audit correlation, no counter state.
  const serial = opts.serial ?? randomBytes(8).readBigUInt64BE(0) >> 1n;
  const validAfter = BigInt(Math.floor(opts.validAfter.getTime() / 1000));
  const validBefore = BigInt(Math.floor(opts.validBefore.getTime() / 1000));
  if (validBefore <= validAfter)
    throw new Error("certificate validity window is empty");

  const extensions: SshCertificateField[] = [
    { name: CERT_EXT_PERMIT_PTY, data: Buffer.alloc(0) },
    { name: CERT_EXT_SANDBOX_ID, data: packedValue(opts.sandboxId) },
    { name: CERT_EXT_USER_ID, data: packedValue(opts.userId) },
    { name: CERT_EXT_WORKSPACE_ID, data: packedValue(opts.workspaceId) },
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const caKeyBlob = ed25519KeyBlob(signer.publicKey);
  const tbs = new WireWriter()
    .writeString(ED25519_CERT_TYPE)
    .writeString(randomBytes(32))
    .writeString(
      opts.userPublicKey.length === 32
        ? opts.userPublicKey
        : parseEd25519KeyBlob(opts.userPublicKey),
    )
    .writeUint64(serial)
    .writeUint32(SSH_CERT_TYPE_USER)
    .writeString(opts.keyId)
    .writeString(new WireWriter().writeString(opts.principal).toBuffer())
    .writeUint64(validAfter)
    .writeUint64(validBefore)
    .writeString(packFields([]))
    .writeString(packFields(extensions))
    .writeString(Buffer.alloc(0))
    .writeString(caKeyBlob)
    .toBuffer();

  const rawSignature = await signer.sign(tbs);
  if (rawSignature.length !== ED25519_SIGNATURE_LENGTH) {
    throw new Error(
      `signer returned ${rawSignature.length} bytes, expected 64`,
    );
  }
  const signatureBlob = new WireWriter()
    .writeString("ssh-ed25519")
    .writeString(rawSignature)
    .toBuffer();
  const blob = new WireWriter()
    .writeBytes(tbs)
    .writeString(signatureBlob)
    .toBuffer();

  return {
    blob,
    line: `${ED25519_CERT_TYPE} ${blob.toString("base64")}`,
    serial,
  };
};

/** Parse a certificate blob; structural checks only — verify separately. */
export const parseCertificateBlob = (blob: Buffer): SshCertificate => {
  const reader = new WireReader(blob);
  const keyType = reader.readString().toString("utf8");
  if (keyType !== ED25519_CERT_TYPE) {
    throw new Error(
      `unsupported certificate type ${keyType} (only ${ED25519_CERT_TYPE})`,
    );
  }
  reader.readString(); // nonce — opaque
  const publicKey = Buffer.from(reader.readString());
  if (publicKey.length !== 32) {
    throw new Error(
      `certificate user key must be 32 bytes, got ${publicKey.length}`,
    );
  }
  const serial = reader.readUint64();
  const certType = reader.readUint32();
  const keyId = reader.readString().toString("utf8");
  const principals = readPackedStrings(reader.readString()).map((p) =>
    p.toString("utf8"),
  );
  const validAfter = reader.readUint64();
  const validBefore = reader.readUint64();
  const criticalOptions = unpackFields(reader.readString());
  const extensions = unpackFields(reader.readString());
  reader.readString(); // reserved
  const signatureKey = Buffer.from(reader.readString());
  const tbs = Buffer.from(blob.subarray(0, reader.position));
  const signatureBlob = reader.readString();
  reader.expectEnd();

  const sigReader = new WireReader(signatureBlob);
  const sigAlgo = sigReader.readString().toString("utf8");
  if (sigAlgo !== "ssh-ed25519") {
    throw new Error(`unsupported certificate signature algorithm ${sigAlgo}`);
  }
  const signature = Buffer.from(sigReader.readString());
  sigReader.expectEnd();

  return {
    publicKey,
    serial,
    certType,
    keyId,
    principals,
    validAfter,
    validBefore,
    criticalOptions,
    extensions,
    signatureKey,
    signature,
    tbs,
    raw: Buffer.from(blob),
  };
};

/** Parse the single-line form (`<type> <base64> [comment]`). */
export const parseCertificateLine = (line: string): SshCertificate => {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== ED25519_CERT_TYPE) {
    throw new Error(
      `expected an "${ED25519_CERT_TYPE} <base64>" certificate line`,
    );
  }
  return parseCertificateBlob(Buffer.from(parts[1] ?? "", "base64"));
};

export class CertificateVerificationError extends Error {
  constructor(
    public readonly reason:
      | "not_user_cert"
      | "wrong_ca"
      | "bad_signature"
      | "expired"
      | "not_yet_valid"
      | "no_principals"
      | "wrong_principal"
      | "unknown_critical_option",
    message: string,
  ) {
    super(message);
    this.name = "CertificateVerificationError";
  }
}

export interface VerifyUserCertificateOptions {
  /** Raw 32-byte CA public key — the verifier's own trust anchor. */
  caPublicKey: Buffer;
  /** When given, the principal list must contain exactly this identity. */
  principal?: string;
  now?: Date;
  /**
   * Skip the validity-window (validAfter/validBefore) check, keeping every
   * other check (CA signature, user-cert type, principal, no critical
   * options). For a re-verification whose freshness is already bounded by a
   * SEPARATE credential — the SSH session broker, where the control-plane
   * grant carries the session's own expiry and the cert's short TTL only ever
   * gated session-OPEN. Never set on the session-open or SSH-auth paths,
   * where the cert's own window is the bound.
   */
  ignoreValidityWindow?: boolean;
}

/**
 * The one verification law every consumer (terminator, broker, control
 * plane) runs: user cert, our CA (embedded key must equal the trust anchor,
 * and the signature must verify against the anchor — never the embedded
 * copy), inside its validity window, non-empty principals (a zero-length
 * list means "any principal" per spec — never minted, always refused), no
 * critical options (we mint none, so any present is foreign), and — when a
 * principal is asserted — an exact match.
 */
export const assertValidUserCertificate = (
  cert: SshCertificate,
  opts: VerifyUserCertificateOptions,
): void => {
  if (cert.certType !== SSH_CERT_TYPE_USER) {
    throw new CertificateVerificationError(
      "not_user_cert",
      "not a user certificate",
    );
  }
  const embeddedCa = parseEd25519KeyBlob(cert.signatureKey);
  if (!embeddedCa.equals(opts.caPublicKey)) {
    throw new CertificateVerificationError(
      "wrong_ca",
      "certificate is not signed by our CA",
    );
  }
  if (!ed25519Verify(opts.caPublicKey, cert.tbs, cert.signature)) {
    throw new CertificateVerificationError(
      "bad_signature",
      "CA signature does not verify",
    );
  }
  if (!opts.ignoreValidityWindow) {
    const now = BigInt(Math.floor((opts.now ?? new Date()).getTime() / 1000));
    if (now < cert.validAfter) {
      throw new CertificateVerificationError(
        "not_yet_valid",
        "certificate is not yet valid",
      );
    }
    if (now >= cert.validBefore) {
      throw new CertificateVerificationError(
        "expired",
        "certificate has expired",
      );
    }
  }
  if (cert.principals.length === 0) {
    throw new CertificateVerificationError(
      "no_principals",
      "certificate has no principals",
    );
  }
  if (cert.criticalOptions.length > 0) {
    throw new CertificateVerificationError(
      "unknown_critical_option",
      `unknown critical option ${cert.criticalOptions[0]?.name ?? ""}`,
    );
  }
  if (
    opts.principal !== undefined &&
    !cert.principals.includes(opts.principal)
  ) {
    throw new CertificateVerificationError(
      "wrong_principal",
      "principal not authorized",
    );
  }
};

/**
 * Proof-of-possession check for the SSH auth exchange: the client signed
 * `data` (ssh2's ctx.blob) with the certificate's embedded user key. ssh2
 * hands the signature through un-normalized for cert algorithms, so accept
 * both the raw 64 bytes and the SSH-wrapped (`string algo + string sig`)
 * form.
 */
export const verifyPossession = (
  cert: SshCertificate,
  data: Buffer,
  signature: Buffer,
): boolean => {
  let raw = signature;
  if (raw.length !== ED25519_SIGNATURE_LENGTH) {
    try {
      const reader = new WireReader(signature);
      const algo = reader.readString().toString("utf8");
      const inner = Buffer.from(reader.readString());
      reader.expectEnd();
      if (algo !== "ssh-ed25519") return false;
      raw = inner;
    } catch {
      return false;
    }
  }
  return ed25519Verify(cert.publicKey, data, raw);
};
