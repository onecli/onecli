import {
  ED25519_SIGNATURE_LENGTH,
  ed25519Verify,
  type Ed25519Signer,
} from "./keys";
import { WireReader, WireWriter } from "./wire";

/**
 * The session grant: a CA-signed capability the control plane issues at
 * session-open and the manager broker REQUIRES before minting exec
 * credentials. It is what closes the compromised-terminator bypass — the
 * broker's own trust anchor (the CA public key) proves the control plane
 * blessed this exact (session, agent, sandbox, workspace) tuple, so caps,
 * revocation-at-open, and audit cannot be skipped by a hostile relay. The
 * grant is NOT a bearer credential against any API family — it is only ever
 * meaningful to the broker, alongside the matching user certificate.
 */

const GRANT_MAGIC = "onecli-ssh-grant-v1";

export interface SshSessionGrant {
  sessionId: string;
  agentId: string;
  sandboxId: string;
  workspaceId: string;
  /** Unix seconds; the broker refuses to mint past this instant. */
  expiresAt: bigint;
}

const grantTbs = (grant: SshSessionGrant): Buffer =>
  new WireWriter()
    .writeString(GRANT_MAGIC)
    .writeString(grant.sessionId)
    .writeString(grant.agentId)
    .writeString(grant.sandboxId)
    .writeString(grant.workspaceId)
    .writeUint64(grant.expiresAt)
    .toBuffer();

export const signGrant = async (
  grant: SshSessionGrant,
  signer: Ed25519Signer,
): Promise<string> => {
  const tbs = grantTbs(grant);
  const signature = await signer.sign(tbs);
  if (signature.length !== ED25519_SIGNATURE_LENGTH) {
    throw new Error(`signer returned ${signature.length} bytes, expected 64`);
  }
  return new WireWriter()
    .writeBytes(tbs)
    .writeString(signature)
    .toBuffer()
    .toString("base64");
};

export class GrantVerificationError extends Error {
  constructor(
    public readonly reason: "malformed" | "bad_signature" | "expired",
    message: string,
  ) {
    super(message);
    this.name = "GrantVerificationError";
  }
}

export const verifyGrant = (
  encoded: string,
  caPublicKey: Buffer,
  now: Date = new Date(),
): SshSessionGrant => {
  let grant: SshSessionGrant;
  let tbs: Buffer;
  let signature: Buffer;
  try {
    const blob = Buffer.from(encoded, "base64");
    const reader = new WireReader(blob);
    const magic = reader.readString().toString("utf8");
    if (magic !== GRANT_MAGIC) throw new Error("wrong magic");
    grant = {
      sessionId: reader.readString().toString("utf8"),
      agentId: reader.readString().toString("utf8"),
      sandboxId: reader.readString().toString("utf8"),
      workspaceId: reader.readString().toString("utf8"),
      expiresAt: reader.readUint64(),
    };
    tbs = Buffer.from(blob.subarray(0, reader.position));
    signature = Buffer.from(reader.readString());
    reader.expectEnd();
  } catch {
    throw new GrantVerificationError("malformed", "malformed session grant");
  }
  if (!ed25519Verify(caPublicKey, tbs, signature)) {
    throw new GrantVerificationError(
      "bad_signature",
      "grant signature does not verify",
    );
  }
  if (BigInt(Math.floor(now.getTime() / 1000)) >= grant.expiresAt) {
    throw new GrantVerificationError("expired", "session grant has expired");
  }
  return grant;
};
