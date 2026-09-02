import { generateKeyPairSync } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The SSH front door's DB laws on REAL PostgreSQL (sandbox-platform step 5):
 * the lease-current session as the third keep-awake shape, session-driven
 * start dueness INSIDE the failed-status backoff frame (the hot-loop guard,
 * mutation-covered), wake priority, the lease-aware per-agent cap, the
 * stale-session sweep, and the heartbeat's server-side revocation close.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type DueWork = typeof import("./due-work");
type SshService = typeof import("./ssh-service");
type SshKeyService = typeof import("./ssh-key-service");
type SshCert = typeof import("@onecli/ssh-cert");
type Providers = typeof import("../providers/ssh-ca");

let db: Db;
let dueWork: DueWork;
let ssh: SshService;
let sshKeys: SshKeyService;
let sshCert: SshCert;

const P = "ssh-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const RUNNER = `${P}runner`;
const USER = `${P}user`;
// A second account for the cross-user fences (registered keys are personal).
const OTHER_USER = `${P}user-b`;
const ACTOR = {
  userId: USER,
  userEmail: "ssh-user@example.com",
  organizationId: ORG,
};

const CAPABILITIES = {
  maxSandboxes: 8,
  backend: "docker",
  homeDurability: "snapshot",
};

let userKeyLine: string;

const reset = async () => {
  await db.sshSession.deleteMany({ where: { agentId: { startsWith: "" } } });
  await db.sshCertMint.deleteMany({});
  await db.userSshKey.deleteMany({
    where: { userId: { in: [USER, OTHER_USER] } },
  });
  await db.sandbox.deleteMany({ where: { runnerId: RUNNER } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: RUNNER } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  // The audit rows this suite's mints/sessions wrote reference the users.
  await db.auditLog.deleteMany({
    where: { userId: { in: [USER, OTHER_USER] } },
  });
  await db.user.deleteMany({ where: { id: { in: [USER, OTHER_USER] } } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
};

const seedBase = async () => {
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "SSH Workspace", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: USER,
      email: "ssh-user@example.com",
      externalAuthId: `${P}auth`,
    },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: USER,
      userEmail: "ssh-user@example.com",
      role: "member",
    },
  });
  await db.runner.create({
    data: {
      id: RUNNER,
      name: RUNNER,
      token: `rnr_${P}token`,
      capabilities: CAPABILITIES,
      lastSeenAt: new Date(),
    },
  });
};

const seedAgentWithSandbox = async (
  suffix: string,
  sandbox: { status: string; updatedAt?: Date; lastActiveAt?: Date },
): Promise<{ agentId: string; sandboxId: string }> => {
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "jcode",
      sandbox: {
        create: {
          id: `${P}sbx-${suffix}`,
          runnerId: RUNNER,
          status: sandbox.status,
          homeAppliedGeneration: 1,
          ...(sandbox.lastActiveAt && { lastActiveAt: sandbox.lastActiveAt }),
        },
      },
    },
    select: { id: true },
  });
  if (sandbox.updatedAt) {
    await db.$executeRaw`UPDATE sandboxes SET updated_at = ${sandbox.updatedAt} WHERE id = ${`${P}sbx-${suffix}`}`;
  }
  return { agentId: agent.id, sandboxId: `${P}sbx-${suffix}` };
};

const seedSession = async (
  ids: { agentId: string; sandboxId: string },
  data: { lastHeartbeatAt: Date; status?: string; openedAt?: Date },
): Promise<string> => {
  const row = await db.sshSession.create({
    data: {
      sandboxId: ids.sandboxId,
      agentId: ids.agentId,
      workspaceId: WORKSPACE,
      userId: USER,
      userEmail: "ssh-user@example.com",
      sourceIp: "203.0.113.7",
      certSerial: "1",
      status: data.status ?? "open",
      lastHeartbeatAt: data.lastHeartbeatAt,
      ...(data.openedAt && { openedAt: data.openedAt }),
    },
    select: { id: true },
  });
  return row.id;
};

const mintCertFor = async (agentId: string): Promise<string> => {
  const minted = await ssh.mintSshCertificate(
    WORKSPACE,
    USER,
    "ssh-user@example.com",
    agentId,
    { publicKey: userKeyLine },
  );
  return minted.certificate;
};

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

beforeAll(async () => {
  if (!PROOF_URL) return;
  // Pin onprem BEFORE the dynamic imports below resolve CAPS at module load
  // (the CI Test job sets NEXT_PUBLIC_EDITION=cloud job-wide — the pg-proof
  // convention, e.g. processes.pg.test.ts, is to override it per file). This
  // suite proves the NON-RBAC access law: the membership fence is the real
  // gate here (`canAccessWorkspaceAsUser` short-circuits to true without an
  // injected checker), which is exactly the path the security review flagged
  // as the one that must hold on editions with no RBAC.
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SANDBOX_IDLE_STOP_SECONDS = "600";
  process.env.SSH_SESSION_LEASE_SECONDS = "90";
  process.env.SSH_MAX_SESSIONS_PER_AGENT = "3";
  // .test TLD like the web fixture (ssh-connect-command.test.ts) — never a
  // real registrable hostname in a synced file.
  process.env.SSH_HOST = "ssh.onecli.test";
  process.env.SSH_CERT_MINTS_PER_HOUR = "5";

  ({ db } = await import("@onecli/db"));
  dueWork = await import("./due-work");
  ssh = await import("./ssh-service");
  sshKeys = await import("./ssh-key-service");
  sshCert = await import("@onecli/ssh-cert");
  const providers: Providers = await import("../providers/ssh-ca");

  // A real in-process CA — the onprem signer shape, injected via the seam.
  const ca = generateKeyPairSync("ed25519");
  const signer = sshCert.ed25519SignerFromPrivateKeyPem(
    ca.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  );
  providers.initSshCa({
    getPublicKey: () => Promise.resolve(signer.publicKey),
    sign: signer.sign,
  });

  const user = generateKeyPairSync("ed25519");
  userKeyLine = sshCert.formatEd25519PublicKeyLine(
    sshCert.spkiToEd25519Raw(
      Buffer.from(user.publicKey.export({ format: "der", type: "spki" })),
    ),
    "tester",
  );

  await reset();
  await seedBase();
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.sshSession.deleteMany({});
  await db.sshCertMint.deleteMany({});
  await db.userSshKey.deleteMany({
    where: { userId: { in: [USER, OTHER_USER] } },
  });
  await db.sandbox.deleteMany({ where: { runnerId: RUNNER } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)("keep-awake: the lease-current session arm", () => {
  it("holds an idle running sandbox out of the stop arm", async () => {
    const ids = await seedAgentWithSandbox("ka", {
      status: "running",
      lastActiveAt: secondsAgo(3600),
    });
    await seedSession(ids, { lastHeartbeatAt: new Date() });
    const work = await dueWork.claimDueWork(RUNNER, 10);
    expect(work.filter((w) => w.kind === "stop")).toEqual([]);
  });

  it("a lease-EXPIRED session holds nothing — the box parks", async () => {
    const ids = await seedAgentWithSandbox("ka2", {
      status: "running",
      lastActiveAt: secondsAgo(3600),
    });
    await seedSession(ids, { lastHeartbeatAt: secondsAgo(300) });
    const work = await dueWork.claimDueWork(RUNNER, 10);
    expect(
      work.filter((w) => w.kind === "stop").map((w) => w.sandboxId),
    ).toEqual([ids.sandboxId]);
  });

  it("a CLOSED session holds nothing even with a fresh heartbeat stamp", async () => {
    const ids = await seedAgentWithSandbox("ka3", {
      status: "running",
      lastActiveAt: secondsAgo(3600),
    });
    await seedSession(ids, { lastHeartbeatAt: new Date(), status: "closed" });
    const work = await dueWork.claimDueWork(RUNNER, 10);
    expect(work.filter((w) => w.kind === "stop")).toHaveLength(1);
  });
});

describe.skipIf(!PROOF_URL)("start dueness: wake-on-connect", () => {
  it("claims a stopped sandbox with a live session and ZERO turns", async () => {
    const ids = await seedAgentWithSandbox("wake", { status: "stopped" });
    await seedSession(ids, { lastHeartbeatAt: new Date() });
    const work = await dueWork.claimDueWork(RUNNER, 10);
    expect(
      work.filter((w) => w.kind === "start").map((w) => w.sandboxId),
    ).toEqual([ids.sandboxId]);
  });

  it("does NOT claim a stopped sandbox whose only session is lease-expired", async () => {
    const ids = await seedAgentWithSandbox("wake2", { status: "stopped" });
    await seedSession(ids, { lastHeartbeatAt: secondsAgo(300) });
    const work = await dueWork.claimDueWork(RUNNER, 10);
    expect(work.filter((w) => w.kind === "start")).toEqual([]);
  });

  it("the failed-status backoff still paces a session wake (hot-loop guard)", async () => {
    // A compose-refused sandbox is `failed` with a fresh updated_at; a live
    // session must NOT bypass the retry pacing — that would reproduce the
    // claim→refuse hot loop the backoff exists to kill.
    const fresh = await seedAgentWithSandbox("hot", {
      status: "failed",
      updatedAt: secondsAgo(5),
    });
    await seedSession(fresh, { lastHeartbeatAt: new Date() });
    expect(
      (await dueWork.claimDueWork(RUNNER, 10)).filter(
        (w) => w.kind === "start",
      ),
    ).toEqual([]);

    // Past the retry window the same shape IS claimed.
    await db.$executeRaw`UPDATE sandboxes SET updated_at = ${secondsAgo(120)} WHERE id = ${fresh.sandboxId}`;
    expect(
      (await dueWork.claimDueWork(RUNNER, 10))
        .filter((w) => w.kind === "start")
        .map((w) => w.sandboxId),
    ).toEqual([fresh.sandboxId]);
  });

  it("ranks a session wake ahead of an aged background-turn wake", async () => {
    const bg = await seedAgentWithSandbox("bg", {
      status: "stopped",
      updatedAt: secondsAgo(1000),
    });
    const conversation = await db.conversation.create({
      data: { agentId: bg.agentId, source: "cron" },
      select: { id: true },
    });
    // An automation turn young enough to rank as background.
    await db.turn.create({
      data: {
        conversationId: conversation.id,
        status: "queued",
        source: "cron",
        message: "scheduled",
      },
    });
    const humans = await seedAgentWithSandbox("hum", {
      status: "stopped",
      updatedAt: secondsAgo(10),
    });
    await seedSession(humans, { lastHeartbeatAt: new Date() });

    const work = await dueWork.claimDueWork(RUNNER, 1);
    expect(
      work.filter((w) => w.kind === "start").map((w) => w.sandboxId),
    ).toEqual([humans.sandboxId]);
  });
});

describe.skipIf(!PROOF_URL)("openSshSession: cap, wake, and refusals", () => {
  it("opens, wakes the parked sandbox, and returns a broker-verifiable grant", async () => {
    const ids = await seedAgentWithSandbox("open", { status: "stopped" });
    const cert = await mintCertFor(ids.agentId);
    // The mint's speculative wake already flips the sandbox; park it again to
    // prove session-open's own flip.
    await db.sandbox.update({
      where: { id: ids.sandboxId },
      data: { status: "stopped" },
    });

    const opened = await ssh.openSshSession(cert, "203.0.113.7");
    expect(opened.sessionId).toBeTruthy();
    expect(opened.policy.heartbeatSeconds).toBeGreaterThan(0);

    const sandbox = await db.sandbox.findUnique({
      where: { id: ids.sandboxId },
    });
    expect(sandbox?.status).toBe("unprovisioned");

    const providers = await import("../providers/ssh-ca");
    const signer = providers.getSshCa();
    if (!signer) throw new Error("test signer missing");
    const grant = sshCert.verifyGrant(
      opened.grant,
      await signer.getPublicKey(),
    );
    expect(grant).toMatchObject({
      sessionId: opened.sessionId,
      agentId: ids.agentId,
      sandboxId: ids.sandboxId,
      workspaceId: WORKSPACE,
    });
  });

  it("caps lease-current sessions per agent — and ignores expired orphans", async () => {
    const ids = await seedAgentWithSandbox("cap", { status: "running" });
    const cert = await mintCertFor(ids.agentId);
    await seedSession(ids, { lastHeartbeatAt: new Date() });
    await seedSession(ids, { lastHeartbeatAt: new Date() });
    await seedSession(ids, { lastHeartbeatAt: new Date() });
    await expect(ssh.openSshSession(cert, "1.1.1.1")).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // A crashed terminator's orphan (stale lease) must not count.
    await db.sshSession.updateMany({
      where: { agentId: ids.agentId },
      data: { lastHeartbeatAt: secondsAgo(300) },
    });
    await expect(ssh.openSshSession(cert, "1.1.1.1")).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
  });

  it("refuses a valid cert for a deleted agent (kill-on-deletion at the door)", async () => {
    const ids = await seedAgentWithSandbox("gone", { status: "running" });
    const cert = await mintCertFor(ids.agentId);
    await db.agent.delete({ where: { id: ids.agentId } });
    await expect(ssh.openSshSession(cert, "1.1.1.1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses a suspended member — the membership fence is live on non-RBAC", async () => {
    const ids = await seedAgentWithSandbox("susp", { status: "running" });
    const cert = await mintCertFor(ids.agentId);
    await db.organizationMember.updateMany({
      where: { organizationId: ORG, userId: USER },
      data: { status: "suspended" },
    });
    try {
      await expect(ssh.openSshSession(cert, "1.1.1.1")).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    } finally {
      await db.organizationMember.updateMany({
        where: { organizationId: ORG, userId: USER },
        data: { status: "active" },
      });
    }
  });

  it("refuses a tampered certificate", async () => {
    const ids = await seedAgentWithSandbox("tamper", { status: "running" });
    const cert = await mintCertFor(ids.agentId);
    const [type, b64] = cert.split(" ");
    const blob = Buffer.from(b64!, "base64");
    blob[80] = (blob[80] ?? 0) ^ 0xff;
    await expect(
      ssh.openSshSession(`${type} ${blob.toString("base64")}`, "1.1.1.1"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rate-limits mints per (user, agent)", async () => {
    const ids = await seedAgentWithSandbox("rate", { status: "running" });
    for (let i = 0; i < 5; i += 1) await mintCertFor(ids.agentId);
    await expect(mintCertFor(ids.agentId)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});

describe.skipIf(!PROOF_URL)("heartbeat + close + sweep", () => {
  it("heartbeat revokes and CLOSES server-side when the agent is deleted", async () => {
    const ids = await seedAgentWithSandbox("hb", { status: "running" });
    const sessionId = await seedSession(ids, { lastHeartbeatAt: new Date() });
    // Deleting the agent cascades the sandbox; the session row must survive
    // long enough to report — cascade removes it entirely, which also reads
    // as revoked (session_gone). Prove BOTH arms: first access revocation on
    // a live agent, then deletion.
    await db.organizationMember.updateMany({
      where: { organizationId: ORG, userId: USER },
      data: { status: "suspended" },
    });
    const beat = await ssh.heartbeatSshSession(sessionId, true);
    expect(beat).toEqual({ revoked: true, reason: "access_revoked" });
    const row = await db.sshSession.findUnique({ where: { id: sessionId } });
    expect(row?.status).toBe("closed");
    expect(row?.closeReason).toBe("access_revoked");
    await db.organizationMember.updateMany({
      where: { organizationId: ORG, userId: USER },
      data: { status: "active" },
    });

    const gone = await seedAgentWithSandbox("hb2", { status: "running" });
    const s2 = await seedSession(gone, { lastHeartbeatAt: new Date() });
    await db.agent.delete({ where: { id: gone.agentId } });
    expect(await ssh.heartbeatSshSession(s2, false)).toMatchObject({
      revoked: true,
    });
  });

  it("close is idempotent and stamps the idle clock for an ATTACHED session", async () => {
    const ids = await seedAgentWithSandbox("close", { status: "running" });
    const sessionId = await seedSession(ids, { lastHeartbeatAt: new Date() });
    // Attach it the way the terminator does (heartbeat with attached=true).
    await ssh.heartbeatSshSession(sessionId, true);
    await ssh.closeSshSession(sessionId, "client_disconnect");
    const first = await db.sshSession.findUnique({ where: { id: sessionId } });
    expect(first?.status).toBe("closed");
    expect(first?.closeReason).toBe("client_disconnect");
    // Second close must not overwrite the reason.
    await ssh.closeSshSession(sessionId, "relay_error");
    const second = await db.sshSession.findUnique({ where: { id: sessionId } });
    expect(second?.closeReason).toBe("client_disconnect");
    const sandbox = await db.sandbox.findUnique({
      where: { id: ids.sandboxId },
    });
    expect(sandbox?.lastActiveAt).toBeTruthy();
  });

  it("a session that NEVER attached must not touch the idle clock", async () => {
    // Measured on the dev live gate: idle-stop is what recovers a sandbox the
    // control plane still reads `running` after its pod vanished (the runner's
    // reconcile only iterates pods it can still see), and that arm is gated on
    // last_active_at. If a failed connect stamped it, a user retrying ssh
    // would push their own agent's recovery out by the idle window each time.
    const ids = await seedAgentWithSandbox("noattach", { status: "running" });
    await db.sandbox.update({
      where: { id: ids.sandboxId },
      data: { lastActiveAt: secondsAgo(3600) },
    });
    const before = (
      await db.sandbox.findUnique({ where: { id: ids.sandboxId } })
    )?.lastActiveAt;
    const sessionId = await seedSession(ids, { lastHeartbeatAt: new Date() });
    // No heartbeat(attached) — the relay never came up (wake_timeout shape).
    await ssh.closeSshSession(sessionId, "wake_timeout");
    const row = await db.sshSession.findUnique({ where: { id: sessionId } });
    expect(row?.closeReason).toBe("wake_timeout");
    expect(row?.attachedAt).toBeNull();
    const after = (
      await db.sandbox.findUnique({ where: { id: ids.sandboxId } })
    )?.lastActiveAt;
    expect(after?.toISOString()).toBe(before?.toISOString());
  });

  it("the sweep closes lease-expired rows and prunes old mint counters", async () => {
    const ids = await seedAgentWithSandbox("sweep", { status: "running" });
    const stale = await seedSession(ids, { lastHeartbeatAt: secondsAgo(300) });
    const live = await seedSession(ids, { lastHeartbeatAt: new Date() });
    await db.sshCertMint.create({
      data: { userId: USER, agentId: ids.agentId },
    });
    await db.sshCertMint.create({
      data: {
        userId: USER,
        agentId: ids.agentId,
        createdAt: new Date(Date.now() - 25 * 3600_000),
      },
    });

    await ssh.sweepSshSessions();

    expect(
      (await db.sshSession.findUnique({ where: { id: stale } }))?.closeReason,
    ).toBe("lease_expired");
    expect(
      (await db.sshSession.findUnique({ where: { id: live } }))?.status,
    ).toBe("open");
    expect(await db.sshCertMint.count({})).toBe(1);
  });
});

// ── Registered SSH keys (the account-level identity registry) ──────────────

const freshUserKeyLine = (comment?: string): string => {
  const pair = generateKeyPairSync("ed25519");
  return sshCert.formatEd25519PublicKeyLine(
    sshCert.spkiToEd25519Raw(
      Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })),
    ),
    comment,
  );
};

const ensureOtherUser = () =>
  db.user.upsert({
    where: { id: OTHER_USER },
    create: {
      id: OTHER_USER,
      email: "ssh-user-b@example.com",
      externalAuthId: `${P}auth-b`,
    },
    update: {},
  });

describe.skipIf(!PROOF_URL)("registered ssh keys", () => {
  it("registers a key, lists it, and dedupes by key material", async () => {
    const created = await sshKeys.createSshKey(ACTOR, {
      name: "MacBook",
      publicKey: userKeyLine,
    });
    expect(created.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(created.lastUsedAt).toBeNull();

    const listed = await sshKeys.listSshKeys(USER);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    // The same key with a DIFFERENT free-text comment is the same identity:
    // canonicalization + the server-computed fingerprint make it collide.
    const recommented = `${userKeyLine.split(/\s+/).slice(0, 2).join(" ")} other@laptop`;
    await expect(
      sshKeys.createSshKey(ACTOR, { name: "Again", publicKey: recommented }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a non-ed25519 key with the actionable message", async () => {
    await expect(
      sshKeys.createSshKey(ACTOR, {
        name: "RSA",
        publicKey: "ssh-rsa AAAAB3Nza",
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("enforces the per-user registry cap", async () => {
    for (let i = 0; i < 25; i++) {
      await sshKeys.createSshKey(ACTOR, {
        name: `key ${i}`,
        publicKey: freshUserKeyLine(),
      });
    }
    await expect(
      sshKeys.createSshKey(ACTOR, {
        name: "one too many",
        publicKey: freshUserKeyLine(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("delete is fenced on the owner and idempotently NOT_FOUND after", async () => {
    await ensureOtherUser();
    const mine = await sshKeys.createSshKey(ACTOR, {
      name: "mine",
      publicKey: userKeyLine,
    });
    const otherActor = {
      userId: OTHER_USER,
      userEmail: "ssh-user-b@example.com",
      organizationId: ORG,
    };

    // Another account's id reads as absent — no cross-user existence oracle.
    await expect(
      sshKeys.deleteSshKey(otherActor, mine.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await sshKeys.listSshKeys(USER)).toHaveLength(1);

    await sshKeys.deleteSshKey(ACTOR, mine.id);
    expect(await sshKeys.listSshKeys(USER)).toHaveLength(0);
    await expect(sshKeys.deleteSshKey(ACTOR, mine.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe.skipIf(!PROOF_URL)("mint from a registered key", () => {
  it("mints from the stored key and stamps lastUsedAt", async () => {
    const ids = await seedAgentWithSandbox("regkey", { status: "running" });
    const key = await sshKeys.createSshKey(ACTOR, {
      name: "MacBook",
      publicKey: userKeyLine,
    });

    const minted = await ssh.mintSshCertificate(
      WORKSPACE,
      USER,
      "ssh-user@example.com",
      ids.agentId,
      { sshKeyId: key.id },
    );
    expect(minted.user).toBe(ids.agentId);
    const cert = sshCert.parseCertificateLine(minted.certificate);
    expect(cert.principals).toEqual([ids.agentId]);

    const row = await db.userSshKey.findUnique({ where: { id: key.id } });
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it("refuses an unknown id and another user's key, stamping nothing", async () => {
    await ensureOtherUser();
    const ids = await seedAgentWithSandbox("regkey-b", { status: "running" });
    const theirs = await sshKeys.createSshKey(
      {
        userId: OTHER_USER,
        userEmail: "ssh-user-b@example.com",
        organizationId: ORG,
      },
      { name: "theirs", publicKey: userKeyLine },
    );

    await expect(
      ssh.mintSshCertificate(
        WORKSPACE,
        USER,
        "ssh-user@example.com",
        ids.agentId,
        {
          sshKeyId: `${P}missing`,
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The mint must never sign another account's key, whatever id arrives.
    await expect(
      ssh.mintSshCertificate(
        WORKSPACE,
        USER,
        "ssh-user@example.com",
        ids.agentId,
        {
          sshKeyId: theirs.id,
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const row = await db.userSshKey.findUnique({ where: { id: theirs.id } });
    expect(row?.lastUsedAt).toBeNull();
  });
});
