import { db, Prisma } from "@onecli/db";
import {
  ed25519Fingerprint,
  formatEd25519PublicKeyLine,
  parseEd25519PublicKeyLine,
} from "@onecli/ssh-cert";

import { MAX_SSH_KEYS_PER_USER } from "../validations/ssh-keys";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "./audit-service";
import { ServiceError } from "./errors";

/**
 * Registered SSH public keys — the account-level identity half of the SSH
 * front door's mint flow. Rows are owned by the person (not a workspace) and
 * hold PUBLIC material only; a row grants nothing by itself, because every
 * certificate mint and session-open re-runs the full access law. Audit rows
 * carry the caller's organizationId (never a workspaceId): without one of
 * the two FKs the account audit view cannot see them.
 */

/** The caller's identity, straight off the auth context. */
export interface SshKeyActor {
  userId: string;
  userEmail: string;
  organizationId: string;
}

const sshKeySelect = {
  id: true,
  name: true,
  fingerprint: true,
  createdAt: true,
  lastUsedAt: true,
} as const;

export type SshKeySummary = Prisma.UserSshKeyGetPayload<{
  select: typeof sshKeySelect;
}>;

export const listSshKeys = (userId: string): Promise<SshKeySummary[]> =>
  db.userSshKey.findMany({
    where: { userId },
    select: sshKeySelect,
    orderBy: { createdAt: "asc" },
  });

export const createSshKey = async (
  actor: SshKeyActor,
  input: { name: string; publicKey: string },
): Promise<SshKeySummary> => {
  let raw: Buffer;
  try {
    raw = parseEd25519PublicKeyLine(input.publicKey);
  } catch {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Only ed25519 public keys are supported — generate one with: ssh-keygen -t ed25519",
    );
  }

  // Soft count-then-create, the mint-budget reasoning: a registered key is
  // inert public material, so a concurrent overshoot of ~N is acceptable and
  // no advisory lock is warranted.
  const count = await db.userSshKey.count({ where: { userId: actor.userId } });
  if (count >= MAX_SSH_KEYS_PER_USER) {
    throw new ServiceError(
      "CONFLICT",
      `SSH key limit reached (${MAX_SSH_KEYS_PER_USER}). Delete a key you no longer use first.`,
    );
  }

  // Canonical line + server-computed fingerprint: the same key pasted with a
  // different free-text comment must collide, and a client-supplied
  // fingerprint would make the unique constraint bypassable.
  const fingerprint = ed25519Fingerprint(raw);
  let sshKey: SshKeySummary;
  try {
    sshKey = await db.userSshKey.create({
      data: {
        userId: actor.userId,
        name: input.name,
        publicKey: formatEd25519PublicKeyLine(raw),
        fingerprint,
      },
      select: sshKeySelect,
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ServiceError(
        "CONFLICT",
        "This key is already registered on your account.",
      );
    }
    throw err;
  }

  await recordAuditEvent({
    organizationId: actor.organizationId,
    userId: actor.userId,
    userEmail: actor.userEmail,
    action: AUDIT_ACTIONS.CREATE,
    service: AUDIT_SERVICES.SSH,
    source: AUDIT_SOURCE.API,
    metadata: { sshKeyId: sshKey.id, fingerprint, name: sshKey.name },
  });

  return sshKey;
};

export const deleteSshKey = async (
  actor: SshKeyActor,
  keyId: string,
): Promise<void> => {
  // Fenced on userId: another user's key id reads as absent, never as
  // forbidden — no existence oracle across accounts.
  const key = await db.userSshKey.findFirst({
    where: { id: keyId, userId: actor.userId },
    select: { id: true, name: true, fingerprint: true },
  });
  if (!key) throw new ServiceError("NOT_FOUND", "SSH key not found");

  // deleteMany keeps the fence on the write too, and a raced concurrent
  // delete lands on count 0 instead of a thrown P2025.
  const deleted = await db.userSshKey.deleteMany({
    where: { id: keyId, userId: actor.userId },
  });
  if (deleted.count === 0) {
    throw new ServiceError("NOT_FOUND", "SSH key not found");
  }

  await recordAuditEvent({
    organizationId: actor.organizationId,
    userId: actor.userId,
    userEmail: actor.userEmail,
    action: AUDIT_ACTIONS.DELETE,
    service: AUDIT_SERVICES.SSH,
    source: AUDIT_SOURCE.API,
    metadata: {
      sshKeyId: key.id,
      fingerprint: key.fingerprint,
      name: key.name,
    },
  });
};

/**
 * Resolve a registered key for the certificate mint. Fenced on userId: the
 * mint must never sign another account's key, whatever id the client sends.
 */
export const resolveSshKeyForMint = async (
  userId: string,
  sshKeyId: string,
): Promise<{ id: string; publicKey: string }> => {
  const key = await db.userSshKey.findFirst({
    where: { id: sshKeyId, userId },
    select: { id: true, publicKey: true },
  });
  if (!key) throw new ServiceError("NOT_FOUND", "SSH key not found");
  return key;
};

/**
 * Stamp a successful mint. updateMany so a concurrently-deleted key is a
 * no-op, not a thrown P2025 — the cert is already minted either way.
 */
export const touchSshKeyUsed = async (sshKeyId: string): Promise<void> => {
  await db.userSshKey.updateMany({
    where: { id: sshKeyId },
    data: { lastUsedAt: new Date() },
  });
};
