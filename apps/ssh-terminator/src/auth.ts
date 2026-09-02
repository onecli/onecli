import {
  ED25519_CERT_TYPE,
  assertValidUserCertificate,
  parseCertificateBlob,
  verifyPossession,
  type SshCertificate,
} from "@onecli/ssh-cert";

/**
 * The publickey auth state machine, pure over a structural ssh2 context so
 * it unit-tests without a live handshake. Certificates only: ssh2 passes
 * OpenSSH cert blobs through UNPARSED (ctx.key.data is the whole cert blob —
 * never call its parseKey on one), so all parsing and verification is ours.
 *
 * Two-phase per the SSH protocol: the check phase (no signature) answers
 * PK_OK only after the full certificate law passes — CA signature, validity,
 * user-cert type, no critical options, principal === username — and the
 * signature phase additionally proves possession of the certified key.
 * Rejections are hint-free (a bare reject, no methods-left beyond the
 * standard publickey advertisement).
 */

export interface AuthContextLike {
  method: string;
  username: string;
  key?: { algo: string; data: Buffer };
  signature?: Buffer;
  blob?: Buffer;
  accept(): void;
  reject(authMethodsLeft?: string[]): void;
}

export type AuthOutcome =
  | { state: "check-passed" }
  | { state: "authenticated"; certificate: SshCertificate; username: string }
  /** `counted` = a real credential failure (feeds SshAuthFailures); the
   * routine `none`-probe rejection every client starts with is not one. */
  | { state: "rejected"; counted: boolean };

export interface AuthenticateOptions {
  /** Raw 32-byte CA public key — the terminator's trust anchor. */
  caPublicKey: Buffer;
  now?: Date;
}

export const authenticate = (
  ctx: AuthContextLike,
  options: AuthenticateOptions,
): AuthOutcome => {
  if (ctx.method !== "publickey") {
    ctx.reject(["publickey"]);
    return { state: "rejected", counted: false };
  }
  const key = ctx.key;
  if (!key || key.algo !== ED25519_CERT_TYPE) {
    ctx.reject(["publickey"]);
    return { state: "rejected", counted: true };
  }
  let certificate: SshCertificate;
  try {
    certificate = parseCertificateBlob(key.data);
    assertValidUserCertificate(certificate, {
      caPublicKey: options.caPublicKey,
      principal: ctx.username,
      now: options.now,
    });
  } catch {
    ctx.reject(["publickey"]);
    return { state: "rejected", counted: true };
  }
  if (ctx.signature === undefined || ctx.blob === undefined) {
    // Check phase — echo PK_OK; the client signs and comes back.
    ctx.accept();
    return { state: "check-passed" };
  }
  if (!verifyPossession(certificate, ctx.blob, ctx.signature)) {
    ctx.reject(["publickey"]);
    return { state: "rejected", counted: true };
  }
  ctx.accept();
  return { state: "authenticated", certificate, username: ctx.username };
};

/** The single-line form the control plane and broker re-verify. */
export const certificateLineOf = (certificate: SshCertificate): string =>
  `${ED25519_CERT_TYPE} ${certificate.raw.toString("base64")}`;
