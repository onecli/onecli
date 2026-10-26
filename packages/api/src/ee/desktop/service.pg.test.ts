/**
 * The desktop takeover's proof suite: the lease is single-holder and lease-fenced, a change reaches the runner
 * poll exactly once, the hand-back resumes an idle agent and nobody else,
 * the sweep releases a silent controller, and the control host answers to
 * the lease holder alone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DESKTOP_CONTROL_PORT,
  DESKTOP_VIEW_PORT,
  MAX_DESKTOP_CONTROLLER_NAME_CHARS,
  runnerWorkResponseSchema,
} from "@onecli/agent-protocol";
import { proofDatabaseUrl } from "../../testing/pg-proof";

const PROOF_URL = proofDatabaseUrl();
const P = "dsk-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OWNER = `${P}owner`;
const MEMBER = `${P}member`;
const OUTSIDER = `${P}outsider`;
const RUNNER = `${P}runner`;
const OLD_RUNNER = `${P}old-runner`;
const TENANT = "T-DSK";

let db: typeof import("@onecli/db").db;
let desktop: typeof import("./service");
let ports: typeof import("../../services/sandbox-port-service");
let dueWork: typeof import("../../services/due-work");

// ── A Slack stand-in for the card path (the action-approval proof's shape) ──
interface SlackCall {
  method: string;
  form: URLSearchParams;
}
let slackServer: Server;
let slackCalls: SlackCall[] = [];
const slackCallsFor = (method: string) =>
  slackCalls.filter((c) => c.method === method);
const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        const method = (req.url ?? "/").slice(1);
        slackCalls.push({ method, form: new URLSearchParams(raw) });
        const body =
          method === "conversations.open"
            ? { channel: { id: "D-OWNER-IM" } }
            : method === "chat.postMessage"
              ? { channel: "D-OWNER-IM", ts: "555.111" }
              : method === "chat.update"
                ? { ts: "555.111" }
                : {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...body }));
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

/** A Slack presence on the agent and the owner linked to it: what makes
 * the owner DM-reachable for the card. */
const seedSlackPresence = async (agentId: string) => {
  const { getCrypto } = await import("../../providers");
  const integration = await db.channelIntegration.create({
    data: {
      organizationId: ORG,
      provider: "slack",
      externalId: TENANT,
      name: "DSK Workspace",
      createdByUserId: OWNER,
    },
    select: { id: true },
  });
  await db.agentChannel.create({
    data: {
      agentId,
      integrationId: integration.id,
      provider: "slack",
      externalId: `${P}bot-${seq}`,
      identityRef: `${P}identity-${seq}`,
      transport: "socket",
      status: "active",
      credentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-dsk-test" }),
      ),
    },
  });
  await db.channelUserLink.create({
    data: {
      integrationId: integration.id,
      externalUserId: "U-OWNER",
      userId: OWNER,
      linkedVia: "manual",
    },
  });
};

const actor = (userId: string) => ({
  userId,
  userEmail: `${userId}@example.com`,
  organizationId: ORG,
});

let seq = 0;
const seedAgent = async (
  input: {
    running?: boolean;
    /** The supervisor's report: true, false, or null for not yet. */
    viewable?: boolean | null;
    runnerId?: string;
  } = {},
) => {
  seq += 1;
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `Desk ${seq}`,
      identifier: `${P}agent-${seq}`,
      accessToken: `aoc_${P}${seq}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  await db.sandbox.create({
    data: {
      id: `${P}sb-${seq}`,
      agentId: agent.id,
      runnerId: input.runnerId ?? RUNNER,
      status: input.running === false ? "stopped" : "running",
      desktopViewable: input.viewable === undefined ? true : input.viewable,
      homeAppliedGeneration: 1,
    },
  });
  // A granted model key, so a resume turn queues instead of failing at
  // birth as `no_model_key` (the conversation proof's grant shape).
  const secret = await db.secret.create({
    data: {
      scope: "workspace",
      workspaceId: WORKSPACE,
      name: `${P}key-${seq}`,
      type: "anthropic",
      encryptedValue: "enc",
      hostPattern: "api.anthropic.com",
      metadata: { authMode: "api-key" },
    },
    select: { id: true },
  });
  await db.policyRuleV2.create({
    data: {
      scope: "workspace",
      workspaceId: WORKSPACE,
      status: "published",
      generation: 1,
      priority: 10,
      isDefault: false,
      enabled: true,
      source: "equipment",
      logicalId: `${P}key-${seq}`,
      name: `${P}key-${seq}`,
      action: "allow",
      requireApproval: false,
      identities: { create: [{ agentId: agent.id }] },
      targets: { create: [{ kind: "secret", secretId: secret.id }] },
    },
  });
  return agent.id;
};

const seedConversation = async (agentId: string, direct = true) => {
  const row = await db.conversation.create({
    data: {
      agentId,
      source: "web",
      direct,
      ...(direct && { userId: OWNER }),
    },
    select: { id: true },
  });
  return row.id;
};

const sessionOf = (agentId: string) =>
  db.desktopSession.findUniqueOrThrow({ where: { agentId } });

/** The two desktop hostnames of an agent, straight from the share rows. */
const hostsOf = async (agentId: string) => {
  const rows = await db.sandboxPort.findMany({
    where: { agentId, kind: "desktop" },
    select: { port: true, slug: true },
  });
  const slugFor = (port: number) => rows.find((r) => r.port === port)?.slug;
  return {
    view: `${slugFor(DESKTOP_VIEW_PORT)}.preview.test`,
    control: `${slugFor(DESKTOP_CONTROL_PORT)}.preview.test`,
  };
};

const reset = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  slackCalls = [];
};

const pushesFor = async (runnerId = RUNNER) =>
  (await dueWork.claimDueWork(runnerId, 10)).filter(
    (item) => item.kind === "desktop.control",
  );

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = await startSlackFake();
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.PREVIEW_DOMAIN = "preview.test";
  process.env.APP_URL = "https://app.example.com";
  process.env.PREVIEW_RELAY_SECRET = "r".repeat(32);
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  ({ db } = await import("@onecli/db"));
  desktop = await import("./service");
  ports = await import("../../services/sandbox-port-service");
  dueWork = await import("../../services/due-work");
  // The implementation is injected at boot on the hosted platform; this
  // suite pins the edition, so it injects it the same way the boot does.
  const { initAgentDesktop } =
    await import("../../providers/hooks/agent-desktop");
  const { eeAgentDesktop } = await import("./index");
  initAgentDesktop(eeAgentDesktop);

  const users = [OWNER, MEMBER, OUTSIDER];
  await reset();
  await db.auditLog.deleteMany({ where: { userId: { in: users } } });
  await db.workspaceAccess.deleteMany({ where: { userId: { in: users } } });
  await db.organizationMember.deleteMany({ where: { userId: { in: users } } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.runner.deleteMany({ where: { id: { in: [RUNNER, OLD_RUNNER] } } });
  await db.runner.createMany({
    data: [
      {
        id: RUNNER,
        name: RUNNER,
        token: `rnr_${RUNNER}`,
        capabilities: {
          maxSandboxes: 4,
          backend: "docker",
          homeDurability: "resident",
          desktopControl: true,
        },
      },
      {
        id: OLD_RUNNER,
        name: OLD_RUNNER,
        token: `rnr_${OLD_RUNNER}`,
        capabilities: {
          maxSandboxes: 4,
          backend: "docker",
          homeDurability: "resident",
        },
      },
    ],
  });
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "DSK", organizationId: ORG },
  });
  await db.user.createMany({
    data: users.map((id) => ({
      id,
      email: `${id}@example.com`,
      externalAuthId: id,
      name: id === OWNER ? "Alex Kim" : null,
    })),
  });
  await db.workspaceAccess.createMany({
    data: [
      { workspaceId: WORKSPACE, userId: OWNER, role: "owner" },
      { workspaceId: WORKSPACE, userId: MEMBER, role: "member" },
    ],
  });
  await db.organizationMember.createMany({
    data: [
      {
        organizationId: ORG,
        userId: OWNER,
        userEmail: `${OWNER}@example.com`,
        role: "owner",
      },
      {
        organizationId: ORG,
        userId: MEMBER,
        userEmail: `${MEMBER}@example.com`,
        role: "member",
      },
    ],
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  slackServer?.close();
});

describe.skipIf(!PROOF_URL)("desktop state", () => {
  it("an available desktop mints its two shares once and hides the control host from a viewer", async () => {
    const agentId = await seedAgent();
    const first = await desktop.desktopFor(WORKSPACE, agentId, MEMBER);
    expect(first).toMatchObject({
      available: true,
      sandboxState: "awake",
      controller: null,
      request: null,
      you: { controlling: false },
      controlHost: null,
    });
    expect(first.viewHost).toMatch(
      /^d-dsk-agent-\d+-[a-z0-9]{4}\.preview\.test$/,
    );
    const again = await desktop.desktopFor(WORKSPACE, agentId, MEMBER);
    expect(again.viewHost).toBe(first.viewHost);
    const rows = await db.sandboxPort.findMany({
      where: { agentId },
      orderBy: { port: "asc" },
    });
    expect(rows.map((r) => [r.port, r.kind, r.revokedAt])).toEqual([
      [DESKTOP_VIEW_PORT, "desktop", null],
      [DESKTOP_CONTROL_PORT, "desktop", null],
    ]);
    expect(rows[1]?.slug.endsWith("-ctl")).toBe(true);
    // Never a preview: not listed, not counted.
    expect((await ports.listSandboxPorts(WORKSPACE, agentId)).shares).toEqual(
      [],
    );
  });

  it("a legacy PREVIEW row on a desktop port is repaired into the desktop share, and its old host stops resolving", async () => {
    // Before 5900/5901 were reserved a person could share them as a
    // preview; that row won the (agent, port) key forever and the Computer
    // section was refused for good (the ticket route and relay both demand
    // a desktop share).
    const agentId = await seedAgent();
    const legacySlug = `p5900-${P}legacy-${seq}`;
    await db.sandboxPort.create({
      data: {
        agentId,
        port: DESKTOP_VIEW_PORT,
        kind: "preview",
        slug: legacySlug,
        visibility: "private",
        createdByUserId: MEMBER,
      },
    });
    await db.sandboxPort.create({
      data: {
        agentId,
        port: DESKTOP_CONTROL_PORT,
        kind: "preview",
        slug: `p5901-${P}legacy-${seq}`,
        visibility: "private",
        revokedAt: new Date(),
      },
    });
    const state = await desktop.desktopFor(WORKSPACE, agentId, OWNER);
    const { view, control } = await hostsOf(agentId);
    expect(state.viewHost).toBe(view);
    expect(view).not.toContain(legacySlug);
    expect(await ports.resolveHost(view)).toMatchObject({
      kind: "desktop",
      desktop: { role: "view" },
    });
    expect(await ports.resolveHost(control)).toMatchObject({
      kind: "desktop",
      desktop: { role: "control" },
    });
    expect(await ports.resolveHost(`${legacySlug}.preview.test`)).toBeNull();
    const rows = await db.sandboxPort.findMany({
      where: { agentId },
      orderBy: { port: "asc" },
    });
    expect(
      rows.map((r) => [r.port, r.kind, r.revokedAt, r.createdByUserId]),
    ).toEqual([
      [DESKTOP_VIEW_PORT, "desktop", null, null],
      [DESKTOP_CONTROL_PORT, "desktop", null, null],
    ]);
    // Stable from here: a second read returns the same hosts.
    const again = await desktop.desktopFor(WORKSPACE, agentId, OWNER);
    expect(again.viewHost).toBe(view);
  });

  it("an asleep or not-yet-viewable desktop is unavailable with no hosts", async () => {
    const asleep = await seedAgent({ running: false });
    expect(await desktop.desktopFor(WORKSPACE, asleep, OWNER)).toMatchObject({
      available: false,
      sandboxState: "asleep",
      viewHost: null,
    });
    const booting = await seedAgent({ viewable: null });
    expect(await desktop.desktopFor(WORKSPACE, booting, OWNER)).toMatchObject({
      available: false,
      sandboxState: "waking",
      viewHost: null,
    });
    // A wake flips a stopped box to `unprovisioned` (claimed by a runner on
    // its next poll): already "waking" to the section, so the Wake button
    // does not come back while the runner is on its way.
    await desktop.wakeDesktop(WORKSPACE, asleep);
    expect(await desktop.desktopFor(WORKSPACE, asleep, OWNER)).toMatchObject({
      available: false,
      sandboxState: "waking",
    });
    // The supervisor reported a desktop nobody can watch (no VNC server):
    // the dashboard says so rather than waiting on a screen forever.
    const unviewable = await seedAgent({ viewable: false });
    expect(
      await desktop.desktopFor(WORKSPACE, unviewable, OWNER),
    ).toMatchObject({
      available: false,
      sandboxState: "unviewable",
      viewHost: null,
    });
    expect(await db.sandboxPort.count({ where: { agentId: asleep } })).toBe(0);
  });

  it("a foreign workspace reads not-found", async () => {
    const agentId = await seedAgent();
    await expect(
      desktop.desktopFor("other-ws", agentId, OWNER),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe.skipIf(!PROOF_URL)("the control lease", () => {
  it("one holder at a time: the second taker gets a 409 naming the first", async () => {
    const agentId = await seedAgent();
    const mine = await desktop.takeControl(WORKSPACE, agentId, actor(OWNER));
    expect(mine.you.controlling).toBe(true);
    expect(mine.controlHost).toMatch(/-ctl\.preview\.test$/);
    expect(mine.controller).toMatchObject({ userId: OWNER, name: "Alex Kim" });
    await expect(
      desktop.takeControl(WORKSPACE, agentId, actor(MEMBER)),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Alex Kim is in control",
    });
    // The other viewer sees who holds it, and no control host.
    const theirs = await desktop.desktopFor(WORKSPACE, agentId, MEMBER);
    expect(theirs.controller?.userId).toBe(OWNER);
    expect(theirs.controlHost).toBeNull();
    expect(theirs.you.controlling).toBe(false);
  });

  it("two simultaneous takes land exactly one controller", async () => {
    const agentId = await seedAgent();
    const results = await Promise.allSettled([
      desktop.takeControl(WORKSPACE, agentId, actor(OWNER)),
      desktop.takeControl(WORKSPACE, agentId, actor(MEMBER)),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
  });

  it("an expired lease is free, and re-taking your own lease renews it", async () => {
    const agentId = await seedAgent();
    await desktop.takeControl(WORKSPACE, agentId, actor(OWNER));
    await db.desktopSession.update({
      where: { agentId },
      data: { controlExpiresAt: new Date(Date.now() - 1000) },
    });
    // Stale = free: the state hides it, and someone else may take it.
    expect(
      (await desktop.desktopFor(WORKSPACE, agentId, MEMBER)).controller,
    ).toBeNull();
    const taken = await desktop.takeControl(WORKSPACE, agentId, actor(MEMBER));
    expect(taken.controller?.userId).toBe(MEMBER);
    const before = (await sessionOf(agentId)).controlExpiresAt;
    await new Promise((r) => setTimeout(r, 5));
    await desktop.takeControl(WORKSPACE, agentId, actor(MEMBER));
    const after = (await sessionOf(agentId)).controlExpiresAt;
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
  });

  it("the heartbeat renews the controller's lease and the idle clock; a watcher's beat renews neither", async () => {
    const agentId = await seedAgent();
    await desktop.takeControl(WORKSPACE, agentId, actor(OWNER));
    const before = (await sessionOf(agentId)).controlExpiresAt!;
    const idleAt = new Date(Date.now() - 60_000);
    await db.sandbox.update({
      where: { agentId },
      data: { lastActiveAt: idleAt },
    });
    const lastActive = async () =>
      (await db.sandbox.findUniqueOrThrow({ where: { agentId } })).lastActiveAt;
    await new Promise((r) => setTimeout(r, 5));
    // A watcher: a tab left open in the background reconnects and beats
    // like anyone else, and must not hold the box out of idle-stop.
    await desktop.markDesktopActivity(agentId, MEMBER, "view");
    expect((await sessionOf(agentId)).controlExpiresAt!.getTime()).toBe(
      before.getTime(),
    );
    expect((await lastActive())!.getTime()).toBe(idleAt.getTime());
    // An anonymous beat (no viewer named) is a watcher too.
    await desktop.markDesktopActivity(agentId, null, "control");
    expect((await lastActive())!.getTime()).toBe(idleAt.getTime());
    // The CONTROLLER watching through the view host (their floating card,
    // a second window) is watching, not driving: that stream must not
    // keep the lease alive once their input stream has closed.
    await desktop.markDesktopActivity(agentId, OWNER, "view");
    expect((await sessionOf(agentId)).controlExpiresAt!.getTime()).toBe(
      before.getTime(),
    );
    expect((await lastActive())!.getTime()).toBe(idleAt.getTime());
    // The controller's input stream: driving is activity, for as long as
    // the lease lives.
    await desktop.markDesktopActivity(agentId, OWNER, "control");
    expect(
      (await sessionOf(agentId)).controlExpiresAt!.getTime(),
    ).toBeGreaterThan(before.getTime());
    expect((await lastActive())!.getTime()).toBeGreaterThan(idleAt.getTime());
    // A lapsed lease renews nothing, so a stale controller's tab cannot
    // keep the box up either.
    await db.sandbox.update({
      where: { agentId },
      data: { lastActiveAt: idleAt },
    });
    await db.desktopSession.update({
      where: { agentId },
      data: { controlExpiresAt: new Date(Date.now() - 1000) },
    });
    await desktop.markDesktopActivity(agentId, OWNER, "control");
    expect((await lastActive())!.getTime()).toBe(idleAt.getTime());
  });

  it("refuses to take an unavailable desktop", async () => {
    const agentId = await seedAgent({ viewable: false });
    await expect(
      desktop.takeControl(WORKSPACE, agentId, actor(OWNER)),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("the controller or an admin may release (every member is an admin on the flat team); nobody releases a free desktop", async () => {
    const agentId = await seedAgent();
    await desktop.takeControl(WORKSPACE, agentId, actor(MEMBER));
    // The org owner takes it off the member. (With RBAC the non-admin
    // refusal is `userIsOrgAdmin`'s, proven in its own suite; this
    // onprem proof runs the flat team, where every member passes it.)
    const released = await desktop.releaseControl(
      WORKSPACE,
      agentId,
      actor(OWNER),
    );
    expect(released.controller).toBeNull();
    await expect(
      desktop.releaseControl(WORKSPACE, agentId, actor(OWNER)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe.skipIf(!PROOF_URL)("the push to the sandbox", () => {
  it("a take and a release each reach the runner poll exactly once, with the controller's name", async () => {
    const agentId = await seedAgent();
    expect(await pushesFor()).toEqual([]);
    await desktop.takeControl(WORKSPACE, agentId, actor(OWNER));
    expect(await pushesFor()).toEqual([
      {
        kind: "desktop.control",
        sandboxId: `${P}sb-${seq}`,
        controlled: true,
        controllerName: "Alex Kim",
      },
    ]);
    expect(await pushesFor()).toEqual([]);
    await desktop.releaseControl(WORKSPACE, agentId, actor(OWNER));
    expect(await pushesFor()).toEqual([
      {
        kind: "desktop.control",
        sandboxId: `${P}sb-${seq}`,
        controlled: false,
      },
    ]);
  });

  it("a profile name over the wire's cap is bounded, so it can never poison the runner's batch", async () => {
    // Names allow 255 characters; the poll item's schema allows 120 and
    // the runner parses a whole batch all-or-nothing, so one long name
    // used to fail every item claimed beside it (other tenants' turns,
    // aborts, steers). The claim must bound it, and the batch must parse.
    const agentId = await seedAgent();
    const longName = `${"A".repeat(200)}\u0007 ${"B".repeat(54)}`;
    await db.user.update({ where: { id: OWNER }, data: { name: longName } });
    try {
      await desktop.takeControl(WORKSPACE, agentId, actor(OWNER));
      const items = await dueWork.claimDueWork(RUNNER, 10);
      const push = items.find((item) => item.kind === "desktop.control");
      expect(push).toMatchObject({ controlled: true });
      const name =
        push?.kind === "desktop.control" ? (push.controllerName ?? "") : "";
      expect(name.length).toBe(MAX_DESKTOP_CONTROLLER_NAME_CHARS);
      expect(name).toBe("A".repeat(MAX_DESKTOP_CONTROLLER_NAME_CHARS));
      expect(() =>
        runnerWorkResponseSchema.parse({ items: [push] }),
      ).not.toThrow();
    } finally {
      await db.user.update({
        where: { id: OWNER },
        data: { name: "Alex Kim" },
      });
    }
  });

  it("a runner without the capability never sees the kind", async () => {
    const agentId = await seedAgent({ runnerId: OLD_RUNNER });
    await desktop.takeControl(WORKSPACE, agentId, actor(OWNER));
    expect(await pushesFor(OLD_RUNNER)).toEqual([]);
    // The change stays armed for a capable runner later.
    expect((await sessionOf(agentId)).controlPushedAt).toBeNull();
  });

  it("a lease that expired before the claim pushes as released", async () => {
    const agentId = await seedAgent();
    await desktop.takeControl(WORKSPACE, agentId, actor(OWNER));
    await db.desktopSession.update({
      where: { agentId },
      data: { controlExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await pushesFor()).toMatchObject([{ controlled: false }]);
  });
});

describe.skipIf(!PROOF_URL)("the agent's ask and the hand-back", () => {
  const ask = (
    agentId: string,
    conversationId: string | null,
    turnId: string | null,
  ) =>
    desktop.requestTakeover({
      agentId,
      reason: "Sign in to the *portal* at https://evil.example please",
      originConversationId: conversationId,
      originTurnId: turnId,
    });

  const seedAskingTurn = async (agentId: string, direct = true) => {
    const conversationId = await seedConversation(agentId, direct);
    const turn = await db.turn.create({
      data: {
        conversationId,
        message: "do the thing",
        status: "done",
        source: "web",
        userId: OWNER,
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    return { conversationId, turnId: turn.id };
  };

  it("concurrent asks claim ONE request: every caller gets the winner's id, and only the winner writes a notice", async () => {
    // Two conversations asking in the same instant (or a retried tool
    // call): before the claim was conditional, both read "no request" and
    // both upserted, the second replacing the first's origin and id.
    const agentId = await seedAgent();
    // One direct thread per person per agent; the others are group threads.
    const a = await seedAskingTurn(agentId);
    const b = await seedAskingTurn(agentId, false);
    const c = await seedAskingTurn(agentId, false);
    // No session row yet either: the first-touch create races too.
    expect(await db.desktopSession.count({ where: { agentId } })).toBe(0);
    const outcomes = await Promise.all([
      ask(agentId, a.conversationId, a.turnId),
      ask(agentId, b.conversationId, b.turnId),
      ask(agentId, c.conversationId, c.turnId),
      ask(agentId, a.conversationId, a.turnId),
    ]);
    const ids = new Set(
      outcomes.map((o) => new URL(o.url!).searchParams.get("takeover")),
    );
    expect(ids.size).toBe(1);
    const session = await sessionOf(agentId);
    expect([...ids][0]).toBe(session.requestId);
    // The stored origin is ONE of the askers, intact (never a mix).
    const origins = [a, b, c].map((t) => `${t.conversationId}/${t.turnId}`);
    expect(origins).toContain(
      `${session.requestConversationId}/${session.requestTurnId}`,
    );
    // One pending notice in total: the losers wrote nothing.
    const notices = await db.turnEvent.findMany({
      where: {
        conversationId: { in: [a, b, c].map((t) => t.conversationId) },
        type: "notice",
      },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.conversationId).toBe(session.requestConversationId);
  });

  it("records one request with an inert reason, a notice, and a deep link; a repeat re-uses it", async () => {
    const agentId = await seedAgent();
    const { conversationId, turnId } = await seedAskingTurn(agentId);
    const first = await ask(agentId, conversationId, turnId);
    expect(first.status).toBe("requested");
    const url = new URL(first.url!);
    expect(url.origin).toBe("https://app.example.com");
    expect(url.pathname).toBe(`/w/${WORKSPACE}/agents/${agentId}/computer`);
    const requestId = url.searchParams.get("takeover");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const session = await sessionOf(agentId);
    expect(session.requestId).toBe(requestId);
    expect(session.requestReason).toBe(
      "Sign in to the portal at evil․example please",
    );
    expect(session.requestConversationId).toBe(conversationId);
    expect(session.requestTurnId).toBe(turnId);
    const state = await desktop.desktopFor(WORKSPACE, agentId, OWNER);
    expect(state.request).toMatchObject({
      id: requestId,
      reason: session.requestReason,
    });
    const notices = await db.turnEvent.findMany({
      where: { conversationId, type: "notice" },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({
      level: "warn",
      text: "Needs you on the desktop: Sign in to the portal at evil․example please",
      desktopRequest: { id: requestId, outcome: "pending" },
    });
    const second = await ask(agentId, conversationId, turnId);
    expect(second.url).toBe(first.url);
    expect(
      await db.turnEvent.count({ where: { conversationId, type: "notice" } }),
    ).toBe(1);
  });

  it("refuses when the desktop is not viewable", async () => {
    const agentId = await seedAgent({ viewable: false });
    await expect(ask(agentId, null, null)).rejects.toMatchObject({
      code: "UNPROCESSABLE",
    });
  });

  it("done by the controller settles the ask, writes the notice, and resumes the idle agent as a platform turn in the asking thread", async () => {
    const agentId = await seedAgent();
    const { conversationId, turnId } = await seedAskingTurn(agentId);
    await ask(agentId, conversationId, turnId);
    await desktop.takeControl(WORKSPACE, agentId, actor(OWNER));
    const state = await desktop.releaseControl(
      WORKSPACE,
      agentId,
      actor(OWNER),
    );
    expect(state.request).toBeNull();
    expect(state.controller).toBeNull();
    const session = await sessionOf(agentId);
    expect(session.requestId).toBeNull();
    const notices = await db.turnEvent.findMany({
      where: { conversationId, type: "notice", turnId },
      orderBy: { seq: "asc" },
    });
    expect(notices.at(-1)?.payload).toMatchObject({
      level: "info",
      text: "Alex Kim took over the desktop and is done.",
      desktopRequest: { outcome: "done" },
    });
    const turns = await db.turn.findMany({
      where: { conversationId, status: "queued" },
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      source: "desktop",
      userId: null,
      message:
        "Alex Kim took control of your desktop and is done. Look at the screen as it is now and continue.",
    });
  });

  it("done with a turn already live steers nothing here and queues no second turn", async () => {
    const agentId = await seedAgent();
    const { conversationId, turnId } = await seedAskingTurn(agentId);
    await db.turn.update({
      where: { id: turnId },
      data: { status: "running", finishedAt: null },
    });
    await ask(agentId, conversationId, turnId);
    await desktop.takeControl(WORKSPACE, agentId, actor(OWNER));
    await desktop.releaseControl(WORKSPACE, agentId, actor(OWNER));
    expect(await db.turn.count({ where: { conversationId } })).toBe(1);
    expect((await sessionOf(agentId)).requestId).toBeNull();
  });

  it("a member who cannot read the asking thread hands back without writing into it: no turn, no name", async () => {
    // The ask came from OWNER's PRIVATE direct thread; the Computer section
    // is workspace-wide, so MEMBER sees it and may take control. Their
    // hand-back must never speak inside OWNER's session: before the fence,
    // it queued a platform turn there carrying MEMBER's name through the
    // direct-wake door (SEC-003).
    const agentId = await seedAgent();
    const { conversationId, turnId } = await seedAskingTurn(agentId);
    await ask(agentId, conversationId, turnId);
    await db.user.update({ where: { id: MEMBER }, data: { name: "Mallory" } });
    try {
      await desktop.takeControl(WORKSPACE, agentId, actor(MEMBER));
      await desktop.releaseControl(WORKSPACE, agentId, actor(MEMBER));
      expect(
        await db.turn.count({ where: { conversationId, source: "desktop" } }),
      ).toBe(0);
      const notices = await db.turnEvent.findMany({
        where: { conversationId, type: "notice" },
        orderBy: { seq: "asc" },
      });
      const written = JSON.stringify(notices.map((n) => n.payload));
      expect(written).not.toContain("Mallory");
      expect(notices.at(-1)?.payload).toMatchObject({
        text: "A teammate took over the desktop and handed it back. Ask again here if the step still needs you.",
        desktopRequest: { outcome: "done" },
      });
      // The ask is still settled (the lease and the request are the truth).
      expect((await sessionOf(agentId)).requestId).toBeNull();
      expect((await sessionOf(agentId)).controllerUserId).toBeNull();
    } finally {
      await db.user.update({ where: { id: MEMBER }, data: { name: null } });
    }
  });

  it("an admin releasing a member's lease on a private-thread ask does not name that member there", async () => {
    const agentId = await seedAgent();
    const { conversationId, turnId } = await seedAskingTurn(agentId);
    await ask(agentId, conversationId, turnId);
    await db.user.update({ where: { id: MEMBER }, data: { name: "Mallory" } });
    try {
      await desktop.takeControl(WORKSPACE, agentId, actor(MEMBER));
      await desktop.releaseControl(WORKSPACE, agentId, actor(OWNER));
      const notices = await db.turnEvent.findMany({
        where: { conversationId, type: "notice" },
        orderBy: { seq: "asc" },
      });
      const written = JSON.stringify(notices.map((n) => n.payload));
      expect(written).not.toContain("Mallory");
      expect(notices.at(-1)?.payload).toMatchObject({
        text: "A teammate took over the desktop and handed it back. Ask again here if the step still needs you.",
      });
    } finally {
      await db.user.update({ where: { id: MEMBER }, data: { name: null } });
    }
  });

  it("an admin taking control off someone settles the ask but does not resume as if they finished", async () => {
    const agentId = await seedAgent();
    const { conversationId, turnId } = await seedAskingTurn(agentId);
    await ask(agentId, conversationId, turnId);
    await desktop.takeControl(WORKSPACE, agentId, actor(MEMBER));
    await desktop.releaseControl(WORKSPACE, agentId, actor(OWNER));
    expect(
      await db.turn.count({ where: { conversationId, status: "queued" } }),
    ).toBe(0);
    expect((await sessionOf(agentId)).requestId).toBeNull();
  });

  it("a group thread's ask resumes through the system door", async () => {
    const agentId = await seedAgent();
    const { conversationId, turnId } = await seedAskingTurn(agentId, false);
    await ask(agentId, conversationId, turnId);
    await desktop.takeControl(WORKSPACE, agentId, actor(OWNER));
    await desktop.releaseControl(WORKSPACE, agentId, actor(OWNER));
    expect(
      await db.turn.count({
        where: { conversationId, status: "queued", source: "desktop" },
      }),
    ).toBe(1);
  });
});

describe.skipIf(!PROOF_URL)("the sweep", () => {
  it("releases a silent controller as a timeout, settles the ask, pushes the release, resumes nobody", async () => {
    const agentId = await seedAgent();
    const conversationId = await seedConversation(agentId);
    const turn = await db.turn.create({
      data: {
        conversationId,
        message: "x",
        status: "done",
        source: "web",
        userId: OWNER,
      },
      select: { id: true },
    });
    await desktop.requestTakeover({
      agentId,
      reason: "captcha",
      originConversationId: conversationId,
      originTurnId: turn.id,
    });
    await desktop.takeControl(WORKSPACE, agentId, actor(OWNER));
    await pushesFor(); // drain the take
    expect(await desktop.sweepDesktopSessions()).toEqual({
      leasesReleased: 0,
      requestsExpired: 0,
    });
    await db.desktopSession.update({
      where: { agentId },
      data: { controlExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await desktop.sweepDesktopSessions()).toEqual({
      leasesReleased: 1,
      requestsExpired: 0,
    });
    const session = await sessionOf(agentId);
    expect(session.controllerUserId).toBeNull();
    expect(session.requestId).toBeNull();
    expect(await pushesFor()).toMatchObject([{ controlled: false }]);
    expect(
      await db.turn.count({ where: { conversationId, status: "queued" } }),
    ).toBe(0);
    const notices = await db.turnEvent.findMany({
      where: { conversationId, type: "notice" },
      orderBy: { seq: "asc" },
    });
    expect(notices.at(-1)?.payload).toMatchObject({
      text: "Alex Kim's control of the desktop timed out (the tab closed or went quiet).",
      desktopRequest: { outcome: "timeout" },
    });
  });

  it("expires a day-old ask nobody answered", async () => {
    const agentId = await seedAgent();
    await desktop.requestTakeover({
      agentId,
      reason: "captcha",
      originConversationId: null,
      originTurnId: null,
    });
    expect(await desktop.sweepDesktopSessions()).toEqual({
      leasesReleased: 0,
      requestsExpired: 0,
    });
    await db.desktopSession.update({
      where: { agentId },
      data: {
        requestedAt: new Date(Date.now() - desktop.REQUEST_MAX_AGE_MS - 1000),
      },
    });
    expect(await desktop.sweepDesktopSessions()).toEqual({
      leasesReleased: 0,
      requestsExpired: 1,
    });
    expect((await sessionOf(agentId)).requestId).toBeNull();
  });
});

describe.skipIf(!PROOF_URL)("the Slack card", () => {
  it("an ask posts one card per DM-reachable owner with the deep link, records the ref, and the hand-back rewrites it", async () => {
    const agentId = await seedAgent();
    await seedSlackPresence(agentId);
    const conversationId = await seedConversation(agentId);
    const turn = await db.turn.create({
      data: {
        conversationId,
        message: "x",
        status: "done",
        source: "web",
        userId: OWNER,
      },
      select: { id: true },
    });
    const ask = await desktop.requestTakeover({
      agentId,
      reason: "sign in to the <portal>",
      originConversationId: conversationId,
      originTurnId: turn.id,
    });
    const posts = slackCallsFor("chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.form.get("channel")).toBe("D-OWNER-IM");
    const blocks = JSON.parse(posts[0]?.form.get("blocks") ?? "[]") as {
      type: string;
      text?: { text: string };
      elements?: { url?: string; action_id?: string }[];
    }[];
    expect(blocks[0]?.text?.text).toBe(
      `*Desk ${seq}* needs you on its screen: sign in to the portal`,
    );
    expect(blocks[1]?.elements?.[0]?.url).toBe(ask.url);
    expect((await sessionOf(agentId)).requestCardRefs).toEqual([
      { channel: "D-OWNER-IM", ts: "555.111", userId: OWNER },
    ]);
    // (The angle brackets never reached Slack: the service made the reason
    // inert before the card, and the card escapes again on top.)
    // A repeat ask re-uses the pending one: no second card.
    await desktop.requestTakeover({
      agentId,
      reason: "again",
      originConversationId: conversationId,
      originTurnId: turn.id,
    });
    expect(slackCallsFor("chat.postMessage")).toHaveLength(1);

    // Done rewrites the card in place with who did it.
    await desktop.takeControl(WORKSPACE, agentId, actor(OWNER));
    await desktop.releaseControl(WORKSPACE, agentId, actor(OWNER));
    const updates = slackCallsFor("chat.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.form.get("ts")).toBe("555.111");
    expect(updates[0]?.form.get("text")).toBe(
      "\u2705 Alex Kim took over and is done: sign in to the portal",
    );
    expect((await sessionOf(agentId)).requestCardRefs).toEqual([]);
  });

  it("no card without a configured dashboard URL (nowhere to send a person), and the notice still lands", async () => {
    const agentId = await seedAgent();
    await seedSlackPresence(agentId);
    const conversationId = await seedConversation(agentId);
    const turn = await db.turn.create({
      data: {
        conversationId,
        message: "x",
        status: "done",
        source: "web",
        userId: OWNER,
      },
      select: { id: true },
    });
    const saved = process.env.APP_URL;
    delete process.env.APP_URL;
    try {
      const ask = await desktop.requestTakeover({
        agentId,
        reason: "captcha",
        originConversationId: conversationId,
        originTurnId: turn.id,
      });
      expect(ask.url).toBeNull();
      expect(slackCallsFor("chat.postMessage")).toHaveLength(0);
      expect(
        await db.turnEvent.count({ where: { conversationId, type: "notice" } }),
      ).toBe(1);
    } finally {
      process.env.APP_URL = saved;
    }
  });
});

describe.skipIf(!PROOF_URL)("host authorization", () => {
  it("members may view; only the lease holder may use the control host; previews never see desktop hosts", async () => {
    const agentId = await seedAgent();
    const state = await desktop.desktopFor(WORKSPACE, agentId, OWNER);
    const { view, control } = await hostsOf(agentId);
    expect(state.viewHost).toBe(view);
    expect(await ports.userCanViewHost(MEMBER, view)).toBe(true);
    expect(await ports.userCanViewHost(OUTSIDER, view)).toBe(false);
    expect(await ports.userCanViewHost(MEMBER, control)).toBe(false);
    expect(await ports.userCanViewHost(OWNER, control)).toBe(false);
    const taken = await desktop.takeControl(WORKSPACE, agentId, actor(OWNER));
    expect(taken.controlHost).toBe(control);
    expect(await ports.userCanViewHost(OWNER, control)).toBe(true);
    expect(await ports.userCanViewHost(MEMBER, control)).toBe(false);
    // The browser login handoff is for pages, never for a desktop host.
    expect(await ports.authorizePreview(OWNER, view)).toBeNull();
    expect(await ports.authorizePreview(OWNER, control)).toBeNull();
    // What the relay sees.
    const resolved = await ports.resolveHost(control);
    expect(resolved).toMatchObject({
      state: "ok",
      kind: "desktop",
      port: DESKTOP_CONTROL_PORT,
      desktop: { role: "control", controllerUserId: OWNER },
    });
    expect(await ports.resolveHost(view)).toMatchObject({
      kind: "desktop",
      port: DESKTOP_VIEW_PORT,
      desktop: { role: "view", controllerUserId: OWNER },
    });
  });

  it("the runner's allowed ports include the desktop's, and a person cannot share or unshare them", async () => {
    const agentId = await seedAgent();
    await desktop.desktopFor(WORKSPACE, agentId, OWNER);
    expect(await ports.allowedPortsForRunner(RUNNER, `${P}sb-${seq}`)).toEqual(
      expect.arrayContaining([DESKTOP_VIEW_PORT, DESKTOP_CONTROL_PORT]),
    );
    await expect(
      ports.shareSandboxPort({
        workspaceId: WORKSPACE,
        agentId,
        port: DESKTOP_VIEW_PORT,
        userId: OWNER,
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    await expect(
      ports.unshareSandboxPort(WORKSPACE, agentId, DESKTOP_VIEW_PORT),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
