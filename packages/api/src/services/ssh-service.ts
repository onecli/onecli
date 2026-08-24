import { db } from "@onecli/db";
import {
  assertValidUserCertificate,
  buildUserCertificate,
  CERT_EXT_SANDBOX_ID,
  CERT_EXT_USER_ID,
  CERT_EXT_WORKSPACE_ID,
  CertificateVerificationError,
  getExtensionValue,
  parseCertificateLine,
  parseEd25519PublicKeyLine,
  signGrant,
  type Ed25519Signer,
  type SshCertificate,
} from "@onecli/ssh-cert";

import {
  SSH_CERT_MINTS_PER_HOUR,
  SSH_CERT_TTL_SECONDS,
  SSH_HOST,
  SSH_IDLE_TIMEOUT_SECONDS,
  SSH_MAX_SESSION_SECONDS,
  SSH_MAX_SESSIONS_PER_AGENT,
  SSH_SESSION_LEASE_SECONDS,
} from "../lib/env";
import { logger } from "../lib/logger";
import { getSshCa } from "../providers/ssh-ca";
import type { SshCaSigner } from "../providers/types";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "./audit-service";
import { signalWork } from "./due-work";
import { ServiceError } from "./errors";
import { activeMembershipWhere } from "./organization-service";
import { resolveSshKeyForMint, touchSshKeyUsed } from "./ssh-key-service";
import { wakeSandboxFor } from "./turn-service";
import { canAccessWorkspaceAsUser } from "./workspace-access-check";

/**
 * The SSH front door's control-plane half (plans/sandbox-platform.md step 5):
 * certificate minting for authenticated users, and the terminator's session
 * surface (open / heartbeat / close) — the narrow terminator↔control-plane
 * channel §3.8 pre-authorized. Liveness truth is the heartbeat LEASE
 * (`SSH_SESSION_LEASE_SECONDS`), never the status column alone; the
 * stale-session sweep closes what a crashed terminator abandoned.
 */

const log = logger.child({ component: "ssh" });

/** Whether the SSH surface is live on this deployment (instance posture). */
export const sshAvailable = (): boolean =>
  Boolean(SSH_HOST) && getSshCa() !== null;

const requireSigner = (): SshCaSigner => {
  const signer = getSshCa();
  if (!signer || !SSH_HOST) {
    // Dark, not broken: same posture as the runner surface without a token.
    throw new ServiceError(
      "NOT_FOUND",
      "SSH is not available on this deployment",
    );
  }
  return signer;
};

/** Adapt the provider (async public key) to the codec's signer shape. */
const asEd25519Signer = async (
  signer: SshCaSigner,
): Promise<Ed25519Signer> => ({
  publicKey: await signer.getPublicKey(),
  sign: signer.sign,
});

// ── Certificate minting ────────────────────────────────────────────────────

export interface MintedSshCertificate {
  certificate: string;
  host: string;
  /** The SSH username — the immutable agent id (the cert's principal). */
  user: string;
  serial: string;
  expiresAt: string;
}

/** Exactly one key source: a pasted line, or a registered key's id. */
export type SshCertificateKeySource =
  | { publicKey: string }
  | { sshKeyId: string };

export const mintSshCertificate = async (
  workspaceId: string,
  userId: string,
  userEmail: string,
  agentId: string,
  source: SshCertificateKeySource,
): Promise<MintedSshCertificate> => {
  const signer = requireSigner();

  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      id: true,
      kind: true,
      workspaceId: true,
      sandbox: { select: { id: true } },
    },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  if (agent.kind !== "hosted") {
    throw new ServiceError(
      "UNPROCESSABLE",
      "SSH is only available for hosted agents",
    );
  }
  if (!agent.sandbox) {
    throw new ServiceError("CONFLICT", "Agent has no sandbox");
  }

  // Registered-key resolution is fenced on userId inside the service (never
  // sign another account's key); the stored line is canonical by
  // construction, so its parse cannot take the 422 arm below.
  let userKey: Buffer;
  let mintedFromKeyId: string | null = null;
  if ("sshKeyId" in source) {
    const registered = await resolveSshKeyForMint(userId, source.sshKeyId);
    userKey = parseEd25519PublicKeyLine(registered.publicKey);
    mintedFromKeyId = registered.id;
  } else {
    try {
      userKey = parseEd25519PublicKeyLine(source.publicKey);
    } catch {
      throw new ServiceError(
        "UNPROCESSABLE",
        "Only ed25519 public keys are supported — generate one with: ssh-keygen -t ed25519",
      );
    }
  }

  // Anti-abuse budget, fail-closed: a DB error refuses the mint rather than
  // waving it through uncounted (the audit log is deliberately NOT the
  // counter — audit writes are best-effort). Deliberately a SOFT limit: this
  // count-then-create is not serialized, so N concurrent mints for one
  // (user, agent) can overshoot by ~N — acceptable, because a minted cert is
  // inert without the private key the server never sees, and every cert is
  // already scoped to an agent the caller can reach. Unlike session-open's
  // hard cap, no advisory lock is warranted here.
  const windowStart = new Date(Date.now() - 3600_000);
  const recent = await db.sshCertMint.count({
    where: { userId, agentId, createdAt: { gt: windowStart } },
  });
  if (recent >= SSH_CERT_MINTS_PER_HOUR) {
    throw new ServiceError(
      "RATE_LIMITED",
      "Too many certificates minted — try again later",
    );
  }
  await db.sshCertMint.create({ data: { userId, agentId } });

  const validAfter = new Date(Date.now() - 60_000); // clock-skew allowance
  const validBefore = new Date(Date.now() + SSH_CERT_TTL_SECONDS * 1000);
  const built = await buildUserCertificate(
    {
      userPublicKey: userKey,
      keyId: JSON.stringify({
        u: userId,
        e: userEmail,
        a: agentId,
        w: workspaceId,
      }),
      principal: agentId,
      validAfter,
      validBefore,
      sandboxId: agent.sandbox.id,
      workspaceId,
      userId,
    },
    await asEd25519Signer(signer),
  );

  await recordAuditEvent({
    workspaceId,
    userId,
    userEmail,
    action: AUDIT_ACTIONS.MINT,
    service: AUDIT_SERVICES.SSH,
    source: AUDIT_SOURCE.API,
    metadata: {
      agentId,
      serial: built.serial.toString(),
      ttlSeconds: SSH_CERT_TTL_SECONDS,
      ...(mintedFromKeyId ? { sshKeyId: mintedFromKeyId } : {}),
    },
  });

  // "Last used" on the registered key means "a cert was minted from it" —
  // the closest observable moment; the control plane never sees the connect.
  if (mintedFromKeyId) await touchSshKeyUsed(mintedFromKeyId);

  // Speculative wake (issues-file fold-in): the mint is a strong signal an
  // SSH connect is seconds away — start the boot now so wake-on-connect
  // usually finds a warm pod. One-shot: if the user never connects, the
  // ordinary idle-stop parks it again.
  await wakeSandboxFor(agentId);
  signalWork();

  return {
    certificate: built.line,
    host: SSH_HOST,
    user: agentId,
    serial: built.serial.toString(),
    expiresAt: validBefore.toISOString(),
  };
};

// ── The terminator session surface ─────────────────────────────────────────

export interface SshSessionPolicy {
  maxSessionSeconds: number;
  idleTimeoutSeconds: number;
  heartbeatSeconds: number;
}

const sessionPolicy = (): SshSessionPolicy => ({
  maxSessionSeconds: SSH_MAX_SESSION_SECONDS,
  idleTimeoutSeconds: SSH_IDLE_TIMEOUT_SECONDS,
  heartbeatSeconds: Math.max(5, Math.floor(SSH_SESSION_LEASE_SECONDS / 3)),
});

const leaseWindowStart = (): Date =>
  new Date(Date.now() - SSH_SESSION_LEASE_SECONDS * 1000);

/**
 * The full access law, mirroring `resolveWorkspaceId`'s per-request gate:
 * workspace row exists → active (non-suspended) org membership →
 * `canAccessWorkspaceAsUser`. The membership fence is what keeps revocation
 * REAL on non-RBAC editions, where `canAccessWorkspaceAsUser` alone is
 * unconditionally true.
 */
const userMayAccessWorkspace = async (
  userId: string,
  workspaceId: string,
): Promise<boolean> => {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, organizationId: true },
  });
  if (!workspace) return false;
  const membership = await db.organizationMember.findFirst({
    where: {
      userId,
      organizationId: workspace.organizationId,
      ...activeMembershipWhere,
    },
    select: { userId: true },
  });
  if (!membership) return false;
  return canAccessWorkspaceAsUser(userId, workspace);
};

interface CertIdentity {
  cert: SshCertificate;
  agentId: string;
  sandboxId: string;
  workspaceId: string;
  userId: string;
}

/**
 * Verify a presented certificate against OUR CA and pull the signed identity
 * out of it. The terminator's word is never trusted — every id comes from
 * material this control plane signed at mint time.
 */
const verifyPresentedCertificate = async (
  certificateLine: string,
): Promise<CertIdentity> => {
  const signer = requireSigner();
  let cert: SshCertificate;
  try {
    cert = parseCertificateLine(certificateLine);
    assertValidUserCertificate(cert, {
      caPublicKey: await signer.getPublicKey(),
    });
  } catch (err) {
    if (err instanceof CertificateVerificationError) {
      throw new ServiceError("FORBIDDEN", `certificate refused: ${err.reason}`);
    }
    throw new ServiceError("FORBIDDEN", "certificate refused: malformed");
  }
  const agentId = cert.principals[0];
  const sandboxId = getExtensionValue(cert, CERT_EXT_SANDBOX_ID);
  const workspaceId = getExtensionValue(cert, CERT_EXT_WORKSPACE_ID);
  const userId = getExtensionValue(cert, CERT_EXT_USER_ID);
  if (!agentId || !sandboxId || !workspaceId || !userId) {
    throw new ServiceError(
      "FORBIDDEN",
      "certificate refused: missing identity extensions",
    );
  }
  return { cert, agentId, sandboxId, workspaceId, userId };
};

export interface OpenedSshSession {
  sessionId: string;
  grant: string;
  policy: SshSessionPolicy;
}

export const openSshSession = async (
  certificateLine: string,
  sourceIp: string,
): Promise<OpenedSshSession> => {
  const signer = requireSigner();
  const identity = await verifyPresentedCertificate(certificateLine);
  const { agentId, sandboxId, workspaceId, userId } = identity;

  // Re-derive DB truth for every signed claim: the cert binds ids, the DB
  // decides whether they still hold (agent deleted? sandbox replaced?).
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true, kind: true, sandbox: { select: { id: true } } },
  });
  if (
    !agent ||
    agent.kind !== "hosted" ||
    !agent.sandbox ||
    agent.sandbox.id !== sandboxId
  ) {
    // The kill-on-deletion fold-in's first half: a connect can never wake a
    // deleted (or re-homed) agent.
    throw new ServiceError("NOT_FOUND", "agent is gone");
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });
  if (!user) throw new ServiceError("FORBIDDEN", "user is gone");
  if (!(await userMayAccessWorkspace(userId, workspaceId))) {
    throw new ServiceError("FORBIDDEN", "workspace access revoked");
  }

  // Cap under an advisory lock so two concurrent connects cannot both pass
  // the count; lease-current only, so a crashed terminator's orphans never
  // brick the agent (the sweep also closes them).
  const session = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ssh-session-open:${agentId}`}))`;
    const open = await tx.sshSession.count({
      where: {
        agentId,
        status: "open",
        lastHeartbeatAt: { gt: leaseWindowStart() },
      },
    });
    if (open >= SSH_MAX_SESSIONS_PER_AGENT) {
      throw new ServiceError(
        "CONFLICT",
        "too many concurrent sessions for this agent",
      );
    }
    return tx.sshSession.create({
      data: {
        sandboxId,
        agentId,
        workspaceId,
        userId,
        userEmail: user.email,
        sourceIp,
        certSerial: identity.cert.serial.toString(),
      },
      select: { id: true },
    });
  });

  await recordAuditEvent({
    workspaceId,
    userId,
    userEmail: user.email,
    action: AUDIT_ACTIONS.SESSION_OPEN,
    service: AUDIT_SERVICES.SSH,
    source: AUDIT_SOURCE.API,
    metadata: {
      agentId,
      sessionId: session.id,
      certSerial: identity.cert.serial.toString(),
      // Terminator-reported: the control plane cannot observe the TCP peer.
      reportedSourceIp: sourceIp,
    },
  });

  // Wake-on-connect: flip a parked sandbox and wake the runner poll. The
  // due-work start arm's session-EXISTS keeps this honest if the flip races
  // a concurrent stop — poll-time truth, the createTurn rule.
  await wakeSandboxFor(agentId);
  signalWork();

  const grant = await signGrant(
    {
      sessionId: session.id,
      agentId,
      sandboxId,
      workspaceId,
      expiresAt: BigInt(
        Math.floor(Date.now() / 1000) + SSH_MAX_SESSION_SECONDS,
      ),
    },
    await asEd25519Signer(signer),
  );

  return { sessionId: session.id, grant, policy: sessionPolicy() };
};

export interface SshHeartbeatResult {
  revoked: boolean;
  reason?: string;
}

/**
 * Renew the session lease and RE-RUN the access law. Revocation is detected
 * here (the pull-shaped kill signal — nothing can dial into the agent VPC),
 * and the row is closed SERVER-SIDE at detection so keep-awake drops even if
 * a hostile terminator keeps heartbeating.
 */
export const heartbeatSshSession = async (
  sessionId: string,
  attached: boolean,
): Promise<SshHeartbeatResult> => {
  const session = await db.sshSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      agentId: true,
      sandboxId: true,
      workspaceId: true,
      userId: true,
      userEmail: true,
      openedAt: true,
      attachedAt: true,
    },
  });
  if (!session) return { revoked: true, reason: "session_gone" };
  if (session.status !== "open")
    return { revoked: true, reason: "session_closed" };

  const agent = await db.agent.findFirst({
    where: { id: session.agentId, workspaceId: session.workspaceId },
    select: { id: true },
  });
  const revokedReason = !agent
    ? "agent_deleted"
    : !(await userMayAccessWorkspace(session.userId, session.workspaceId))
      ? "access_revoked"
      : null;

  if (revokedReason) {
    await closeSshSessionRow(session, revokedReason);
    return { revoked: true, reason: revokedReason };
  }

  const maxSessionEnd = new Date(
    session.openedAt.getTime() + SSH_MAX_SESSION_SECONDS * 1000,
  );
  if (new Date() >= maxSessionEnd) {
    await closeSshSessionRow(session, "max_duration");
    return { revoked: true, reason: "max_duration" };
  }

  await db.sshSession.update({
    where: { id: sessionId },
    data: {
      lastHeartbeatAt: new Date(),
      ...(attached && !session.attachedAt ? { attachedAt: new Date() } : {}),
    },
  });
  return { revoked: false };
};

interface CloseableSession {
  id: string;
  agentId: string;
  sandboxId: string;
  workspaceId: string;
  userId: string;
  userEmail: string;
  openedAt: Date;
  /** Null when the relay never attached — see the idle-clock stamp below. */
  attachedAt: Date | null;
}

/**
 * Close exactly once: the guarded updateMany is the idempotency gate, so the
 * SESSION_CLOSE audit row is written only by the open→closed transition —
 * whether the closer is the terminator, the heartbeat's revocation arm, or
 * the stale-session sweep.
 */
const closeSshSessionRow = async (
  session: CloseableSession,
  reason: string,
): Promise<boolean> => {
  const now = new Date();
  const closed = await db.sshSession.updateMany({
    where: { id: session.id, status: "open" },
    data: { status: "closed", closedAt: now, closeReason: reason },
  });
  if (closed.count === 0) return false;

  await recordAuditEvent({
    workspaceId: session.workspaceId,
    userId: session.userId,
    userEmail: session.userEmail,
    action: AUDIT_ACTIONS.SESSION_CLOSE,
    service: AUDIT_SERVICES.SSH,
    source: AUDIT_SOURCE.API,
    metadata: {
      agentId: session.agentId,
      sessionId: session.id,
      reason,
      durationSeconds: Math.max(
        0,
        Math.round((now.getTime() - session.openedAt.getTime()) / 1000),
      ),
    },
  });

  // A just-ended session usually means "the human stepped away a minute ago",
  // not "idle since the last turn" — restart the idle clock so the box gets
  // the normal window before re-parking (cheap; wake is the expensive half).
  //
  // ONLY for a session that actually ATTACHED. A session that never reached
  // the relay (wake timeout, broker refusal) did no work, and stamping for it
  // is actively harmful: idle-stop is what recovers a sandbox the control
  // plane still reads `running` after its pod vanished out-of-band (node
  // death — the runner's reconcile only iterates pods it can still see), and
  // that arm is gated on `last_active_at`. Stamping on every failed attempt
  // would let a user retrying ssh push their own agent's recovery out by the
  // idle window each time. Measured on the dev live gate.
  if (session.attachedAt) {
    await db.sandbox.updateMany({
      where: { id: session.sandboxId },
      data: { lastActiveAt: now },
    });
  }
  return true;
};

export const closeSshSession = async (
  sessionId: string,
  reason: string,
): Promise<void> => {
  const session = await db.sshSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      agentId: true,
      sandboxId: true,
      workspaceId: true,
      userId: true,
      userEmail: true,
      openedAt: true,
      attachedAt: true,
    },
  });
  if (!session) return; // already swept — closing is idempotent
  await closeSshSessionRow(session, reason);
};

/**
 * The stale-session sweep (the `reclaimStaleTurns` shape, run from the
 * runner poll): close open rows whose lease expired — a crashed terminator
 * reports nothing — and prune mint-counter rows past their window. This is
 * audit-close hygiene, NOT cap protection: the per-agent cap and keep-awake
 * both count only lease-current rows, so a crashed terminator's orphan ages
 * out of both within the lease window on its own; the sweep is what turns
 * that silent orphan into a `closed`/`lease_expired` row (the SESSION_CLOSE
 * audit + the sandbox idle-clock stamp) instead of leaving it dangling.
 */
export const sweepSshSessions = async (): Promise<void> => {
  const stale = await db.sshSession.findMany({
    where: { status: "open", lastHeartbeatAt: { lt: leaseWindowStart() } },
    select: {
      id: true,
      agentId: true,
      sandboxId: true,
      workspaceId: true,
      userId: true,
      userEmail: true,
      openedAt: true,
      attachedAt: true,
    },
    take: 100,
  });
  for (const session of stale) {
    try {
      await closeSshSessionRow(session, "lease_expired");
    } catch (err) {
      log.error(
        { err, sessionId: session.id },
        "failed to close lease-expired ssh session",
      );
    }
  }
  await db.sshCertMint.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } },
  });
};
