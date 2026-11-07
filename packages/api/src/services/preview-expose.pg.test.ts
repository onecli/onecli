import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof";

/**
 * preview_expose proofs: the agent's ask never shares on its own; a human
 * approval does. Pinned:
 *  - an ask reserves the final URL but the host stays unroutable (relay 404)
 *    until approved;
 *  - repeated asks for one port make ONE approval, same URL;
 *  - approve → the share is live, attributed to the approver and approval;
 *  - reject → still unroutable;
 *  - an already-live share answers "live" with no new approval;
 *  - reserved ports are refused.
 */

const PROOF_URL = proofDatabaseUrl();
const P = "pex-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OWNER = `${P}owner`;
const OUTSIDER = `${P}outsider`;
const OTHER_WORKSPACE = `${P}other-ws`;
const RUNNER = `${P}runner`;

let db: typeof import("@onecli/db").db;
let expose: typeof import("./preview-expose-service");
let ports: typeof import("./sandbox-port-service");
let approvals: typeof import("./channels/action-approval-service");

let seq = 0;
const seedAgent = async () => {
  seq += 1;
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `Pex ${seq}`,
      identifier: `${P}agent-${seq}`,
      accessToken: `aoc_${P}${seq}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  return agent.id;
};

const ask = (agentId: string, port: number, startCommand?: string) =>
  expose.requestPreviewExpose({
    agentId,
    port,
    reason: "storefront",
    ...(startCommand && { startCommand }),
    originConversationId: null,
    originTurnId: null,
  });

const hostOf = (url: string) => new URL(url).hostname;

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.PREVIEW_DOMAIN = "preview.test";
  process.env.APP_URL = "https://app.example.com";
  process.env.PREVIEW_RELAY_SECRET = "r".repeat(32);
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  ({ db } = await import("@onecli/db"));
  expose = await import("./preview-expose-service");
  ports = await import("./sandbox-port-service");
  approvals = await import("./channels/action-approval-service");

  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  // Decisions audit as the owner; audit rows RESTRICT user deletes.
  await db.auditLog.deleteMany({
    where: { userId: { in: [OWNER, OUTSIDER] } },
  });
  await db.workspaceAccess.deleteMany({
    where: { userId: { in: [OWNER, OUTSIDER] } },
  });
  await db.organizationMember.deleteMany({
    where: { userId: { in: [OWNER, OUTSIDER] } },
  });
  await db.workspace.deleteMany({
    where: { id: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { in: [OWNER, OUTSIDER] } } });
  await db.runner.deleteMany({ where: { id: RUNNER } });
  await db.runner.create({
    data: { id: RUNNER, name: RUNNER, token: `rnr_${RUNNER}` },
  });
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "PEX", organizationId: ORG },
  });
  await db.user.createMany({
    data: [OWNER, OUTSIDER].map((id) => ({
      id,
      email: `${id}@example.com`,
      externalAuthId: id,
      name: id,
    })),
  });
  await db.workspaceAccess.create({
    data: { workspaceId: WORKSPACE, userId: OWNER, role: "owner" },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: OWNER,
      userEmail: `${OWNER}@example.com`,
      role: "owner",
    },
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
});

describe.skipIf(!PROOF_URL)("preview_expose", () => {
  it("an ask reserves the URL but does not route it", async () => {
    const agentId = await seedAgent();
    const outcome = await ask(agentId, 8080);
    expect(outcome.kind).toBe("held");
    expect(outcome.url).toMatch(
      /^https:\/\/p8080-pex-agent-\d+-[a-z0-9]{4}\.preview\.test$/,
    );
    expect(await ports.resolveHost(hostOf(outcome.url))).toBeNull();
    const rows = await db.actionApproval.findMany({ where: { agentId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toContain(outcome.url);
  });

  it("repeated asks make one approval and the same URL", async () => {
    const agentId = await seedAgent();
    const a = await ask(agentId, 8080);
    const b = await ask(agentId, 8080);
    expect(b.url).toBe(a.url);
    expect(await db.actionApproval.count({ where: { agentId } })).toBe(1);
    // A different port is its own ask.
    await ask(agentId, 3000);
    expect(await db.actionApproval.count({ where: { agentId } })).toBe(2);
  });

  it("approve shares the port, attributed to the approver", async () => {
    const agentId = await seedAgent();
    const held = await ask(agentId, 8080);
    const approval = await db.actionApproval.findFirstOrThrow({
      where: { agentId },
    });
    const result = await approvals.decideActionApproval({
      approvalId: approval.id,
      decision: "approve",
      deciderUserId: OWNER,
    });
    expect(result).toMatchObject({ status: "executed" });
    const route = await ports.resolveHost(hostOf(held.url));
    expect(route).toMatchObject({ state: "ok", port: 8080, agentId });
    const share = await db.sandboxPort.findFirstOrThrow({
      where: { agentId, port: 8080 },
    });
    expect(share.createdByUserId).toBe(OWNER);
    expect(share.approvalId).toBe(approval.id);

    // Now live: a further ask answers immediately, no new card.
    const again = await ask(agentId, 8080);
    expect(again).toEqual({ kind: "live", port: 8080, url: held.url });
    expect(await db.actionApproval.count({ where: { agentId } })).toBe(1);
  });

  it("reject leaves it unroutable", async () => {
    const agentId = await seedAgent();
    const held = await ask(agentId, 8080);
    const approval = await db.actionApproval.findFirstOrThrow({
      where: { agentId },
    });
    await approvals.decideActionApproval({
      approvalId: approval.id,
      decision: "reject",
      deciderUserId: OWNER,
      reason: "not yet",
    });
    expect(await ports.resolveHost(hostOf(held.url))).toBeNull();
  });

  it("the relaunch command rides the ask, survives approval, is restated on a live share, and goes with a revoke", async () => {
    const agentId = await seedAgent();
    // Nothing to relaunch before any ask names a command.
    await ask(agentId, 8080);
    expect(await ports.previewRelaunchesFor(agentId)).toEqual([]);

    // The ask stores it on the reserved row; the row is not live, so the
    // relaunch list still ignores it (a wake must never run the command of
    // a share nobody approved).
    await ask(agentId, 8080, "python3 server.py");
    expect(await ports.previewRelaunchesFor(agentId)).toEqual([]);

    // Approval revives the same row, command intact: now it relaunches.
    const approval = await db.actionApproval.findFirstOrThrow({
      where: { agentId },
    });
    await approvals.decideActionApproval({
      approvalId: approval.id,
      decision: "approve",
      deciderUserId: OWNER,
    });
    expect(await ports.previewRelaunchesFor(agentId)).toEqual([
      { port: 8080, command: "python3 server.py" },
    ]);

    // A further ask on the live share restates the command: the one thing
    // about a share the agent owns.
    await ask(agentId, 8080, "npm start");
    expect(await ports.previewRelaunchesFor(agentId)).toEqual([
      { port: 8080, command: "npm start" },
    ]);

    // Revoking the share withdraws the command with it: a later re-share
    // starts clean. MUTATION-PROOF: drop `startCommand: null` from the
    // unshare and the re-share below relaunches "npm start" unasked.
    await ports.unshareSandboxPort(WORKSPACE, agentId, 8080);
    expect(await ports.previewRelaunchesFor(agentId)).toEqual([]);
    await ports.shareSandboxPort({
      workspaceId: WORKSPACE,
      agentId,
      port: 8080,
      userId: OWNER,
    });
    expect(await ports.previewRelaunchesFor(agentId)).toEqual([]);
  });

  it("refuses reserved ports", async () => {
    const agentId = await seedAgent();
    // 22 (SSH), and the hosted desktop's screen ports: a preview must never
    // put the agent's screen on a page.
    for (const port of [22, 5900, 5901]) {
      await expect(ask(agentId, port)).rejects.toThrow(/can't be previewed/);
    }
    expect(await db.actionApproval.count({ where: { agentId } })).toBe(0);
  });

  it("tenancy: a foreign workspace can't list, share, or unshare; a non-member can't open the preview", async () => {
    const agentId = await seedAgent();
    await db.workspace.upsert({
      where: { id: OTHER_WORKSPACE },
      create: { id: OTHER_WORKSPACE, name: "PEX other", organizationId: ORG },
      update: {},
    });
    await expect(
      ports.listSandboxPorts(OTHER_WORKSPACE, agentId),
    ).rejects.toThrow(/not found/i);
    await expect(
      ports.shareSandboxPort({
        workspaceId: OTHER_WORKSPACE,
        agentId,
        port: 8080,
        userId: OWNER,
      }),
    ).rejects.toThrow(/not found/i);
    expect(await db.sandboxPort.count({ where: { agentId } })).toBe(0);

    const share = await ports.shareSandboxPort({
      workspaceId: WORKSPACE,
      agentId,
      port: 8080,
      userId: OWNER,
    });
    await expect(
      ports.unshareSandboxPort(OTHER_WORKSPACE, agentId, 8080),
    ).rejects.toThrow(/not found/i);
    expect(await ports.userCanViewHost(OWNER, share.hostname)).toBe(true);
    expect(await ports.userCanViewHost(OUTSIDER, share.hostname)).toBe(false);
  });

  it("preview activity restarts the idle clock only for a live share on a running box", async () => {
    const agentId = await seedAgent();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await db.sandbox.create({
      data: { agentId, runnerId: RUNNER, status: "running", lastActiveAt: old },
    });
    const stamp = async () =>
      (await db.sandbox.findFirstOrThrow({ where: { agentId } })).lastActiveAt;

    // Reserved-but-unapproved is not a live share: no effect.
    await ask(agentId, 8080);
    await ports.markPreviewActivity(agentId);
    expect(await stamp()).toEqual(old);

    await ports.shareSandboxPort({
      workspaceId: WORKSPACE,
      agentId,
      port: 8080,
      userId: OWNER,
    });
    await ports.markPreviewActivity(agentId);
    expect((await stamp())!.getTime()).toBeGreaterThan(old.getTime());

    // A stopped box is never touched (waking is /wake's job).
    await db.sandbox.updateMany({
      where: { agentId },
      data: { status: "stopped", lastActiveAt: old },
    });
    await ports.markPreviewActivity(agentId);
    expect(await stamp()).toEqual(old);
  });

  it("the runner's allowlist comes only from live shares, fenced to the runner that hosts the box", async () => {
    // The one source a runner arms from. Reserved (unapproved) asks never
    // count, a different runner learns nothing, and unshare empties it.
    const agentId = await seedAgent();
    const sandbox = await db.sandbox.create({
      data: { agentId, runnerId: RUNNER, status: "running" },
      select: { id: true },
    });
    await ask(agentId, 3000);
    expect(await ports.allowedPortsForRunner(RUNNER, sandbox.id)).toEqual([]);

    await ports.shareSandboxPort({
      workspaceId: WORKSPACE,
      agentId,
      port: 8080,
      userId: OWNER,
    });
    expect(await ports.allowedPortsForRunner(RUNNER, sandbox.id)).toEqual([
      8080,
    ]);
    // Negative control: another runner (or a guessed id) gets nothing.
    expect(
      await ports.allowedPortsForRunner(`${RUNNER}-other`, sandbox.id),
    ).toBeNull();

    await ports.unshareSandboxPort(WORKSPACE, agentId, 8080);
    expect(await ports.allowedPortsForRunner(RUNNER, sandbox.id)).toEqual([]);
  });

  it("discovered ports reach the Ports list only from the hosting runner's live container, and only while running", async () => {
    const processes = await import("./sandbox-process-service");
    const agentId = await seedAgent();
    const sandbox = await db.sandbox.create({
      data: {
        agentId,
        runnerId: RUNNER,
        status: "running",
        containerRef: "ctr-live",
      },
      select: { id: true },
    });
    const listing = () =>
      ports.listSandboxPorts(WORKSPACE, agentId).then((r) => r.listening);
    expect(await listing()).toEqual([]);

    const event = {
      kind: "sandbox.ports" as const,
      sandboxId: sandbox.id,
      containerRef: "ctr-live",
      ports: [80, 8080],
    };
    // Negative controls: a foreign runner, or a frame off a dead container
    // (a re-send in flight across a respawn), is inert.
    await processes.applySandboxPorts(`${RUNNER}-other`, event);
    expect(await listing()).toEqual([]);
    await processes.applySandboxPorts(RUNNER, {
      ...event,
      containerRef: "ctr-dead",
    });
    expect(await listing()).toEqual([]);

    await processes.applySandboxPorts(RUNNER, event);
    expect(await listing()).toEqual([80, 8080]);

    // A box that left `running` offers nothing, whatever the row still holds.
    await db.sandbox.update({
      where: { id: sandbox.id },
      data: { status: "stopped" },
    });
    expect(await listing()).toEqual([]);
  });

  it("the preview route names the runner copy holding the sandbox's socket, only while that copy is live", async () => {
    // A preview stream rides the sandbox's control socket, which lives in
    // exactly one runner copy: the relay must dial THAT copy. The answer
    // comes from the same channel record that routes turns.
    const agentId = await seedAgent();
    const sandbox = await db.sandbox.create({
      data: { agentId, runnerId: RUNNER, status: "running" },
      select: { id: true },
    });
    const holder = await db.runnerReplica.create({
      data: {
        runnerId: RUNNER,
        name: "copy-a",
        portApiUrl: "http://10.0.1.5:8485",
      },
      select: { id: true },
    });
    const share = await ports.shareSandboxPort({
      workspaceId: WORKSPACE,
      agentId,
      port: 8080,
      userId: OWNER,
    });
    const host = hostOf(share.url);
    const route = () => ports.resolveHost(host);

    // No socket held anywhere yet: no copy to name.
    expect(await route()).toMatchObject({
      state: "ok",
      runnerPortApiUrl: null,
    });

    await db.$executeRaw`
      UPDATE sandboxes SET channel_replica_id = ${holder.id},
        channel_connection_id = 'conn-1', channel_since = now()
      WHERE id = ${sandbox.id}`;
    expect(await route()).toMatchObject({
      state: "ok",
      runnerPortApiUrl: "http://10.0.1.5:8485",
    });

    // The socket closed (the supervisor is reconnecting): not routable.
    await db.$executeRaw`
      UPDATE sandboxes SET channel_connection_id = NULL WHERE id = ${sandbox.id}`;
    expect(await route()).toMatchObject({ runnerPortApiUrl: null });

    // Held again, but by a copy that stopped heartbeating: not routable.
    await db.$executeRaw`
      UPDATE sandboxes SET channel_connection_id = 'conn-2' WHERE id = ${sandbox.id}`;
    await db.runnerReplica.update({
      where: { id: holder.id },
      data: { lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) },
    });
    expect(await route()).toMatchObject({ runnerPortApiUrl: null });

    // Heartbeating, but retired (it is shutting down): not routable either,
    // however fresh its last call. MUTATION-PROOF: read only `lastSeenAt`.
    await db.runnerReplica.update({
      where: { id: holder.id },
      data: { lastSeenAt: new Date(), retiredAt: new Date() },
    });
    expect(await route()).toMatchObject({ runnerPortApiUrl: null });

    await db.runnerReplica.delete({ where: { id: holder.id } });
  });
});
