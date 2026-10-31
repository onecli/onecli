import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { proofDatabaseUrl } from "../../testing/pg-proof";

/**
 * Lost-connection alerts: when the provider removes an agent's app, the
 * bell says so instead of the agent going silent unnoticed.
 *
 *  - the bell list names every agent whose presence the removal door flipped
 *    to `disabled`, newest first, and nothing live;
 *  - the route answers everyone who can see the workspace (anyone there can
 *    re-attach) and nobody outside it: a member of another org gets 404 and
 *    never this workspace's alerts;
 *  - the DAILY check flips a presence whose token the provider calls dead,
 *    leaves a rate-limited one alone, survives an unreadable credential,
 *    and walks every live presence in batches before a new lap may start.
 */

const PROOF_URL = proofDatabaseUrl();
const P = "health-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WORKSPACE = `${P}ws`;
const OTHER_WORKSPACE = `${P}other-ws`;
const OWNER = `${P}owner`;
const MEMBER = `${P}member`;
const STRANGER = `${P}stranger`;
const TEAM = "T0HEALTH";
const ADAPTER_TOKEN = `cha_${P}instance`;

let db: typeof import("@onecli/db").db;
let health: typeof import("./channel-health-service");
let providers: typeof import("../../providers");
let app: ReturnType<typeof import("../../app").createApiApp>;
let currentSession: { id: string; email: string } | null = null;

// ── Fake Slack: auth.test answers per bot token ────────────────────────────
let slackServer: Server;
/** botToken → Slack error code; absent = ok. */
const authErrors = new Map<string, string>();
/** Every bot token auth.test was asked about, in order. */
const probed: string[] = [];

const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const method = (req.url ?? "/").slice(1);
        res.writeHead(200, { "content-type": "application/json" });
        if (method !== "auth.test") {
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        probed.push(token);
        const error = authErrors.get(token);
        res.end(
          JSON.stringify(
            error
              ? { ok: false, error }
              : { ok: true, user_id: "U0BOT", team_id: TEAM, bot_id: "B1" },
          ),
        );
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

const seedAgent = async (suffix: string, workspaceId = WORKSPACE) =>
  (
    await db.agent.create({
      data: {
        identifier: `${P}agent-${suffix}`,
        name: `Agent ${suffix}`,
        workspaceId,
        accessToken: `aoc_${P}${suffix}`,
        kind: "hosted",
        harness: "fake",
      },
      select: { id: true },
    })
  ).id;

let integrationId: string;
let otherIntegrationId: string;

const seedPresence = async (
  agentId: string,
  status: "active" | "disabled" | "needs_attention",
  botToken = `xoxb-${agentId}`,
  integration = integrationId,
) => {
  const credentials = await providers
    .getCrypto()
    .encrypt(JSON.stringify({ botToken }));
  return db.agentChannel.create({
    data: {
      agentId,
      integrationId: integration,
      provider: "slack",
      externalId: `${P}app-${agentId}`,
      identityRef: `${P}bot-${agentId}`,
      transport: "socket",
      status,
      credentials,
    },
    select: { id: true },
  });
};

const status = async (id: string) =>
  (await db.agentChannel.findUniqueOrThrow({ where: { id } })).status;

const reset = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = await startSlackFake();
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  ({ db } = await import("@onecli/db"));
  providers = await import("../../providers");
  health = await import("./channel-health-service");
  const { createApiApp } = await import("../../app");
  app = createApiApp({ getSession: async () => currentSession });

  await reset();
  await db.channelIntegration.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.organizationMember.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.workspace.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.createMany({
    data: [
      { id: ORG, name: ORG, slug: ORG },
      { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
    ],
  });
  await db.workspace.createMany({
    data: [
      { id: WORKSPACE, name: "Health WS", organizationId: ORG },
      { id: OTHER_WORKSPACE, name: "Other WS", organizationId: OTHER_ORG },
    ],
  });
  await db.user.createMany({
    data: [OWNER, MEMBER, STRANGER].map((id) => ({
      id,
      email: `${id}@example.com`,
      externalAuthId: id,
    })),
  });
  await db.organizationMember.createMany({
    data: [
      { organizationId: ORG, userId: OWNER, role: "owner" },
      { organizationId: ORG, userId: MEMBER, role: "member" },
      { organizationId: OTHER_ORG, userId: STRANGER, role: "owner" },
    ].map((m) => ({ ...m, userEmail: `${m.userId}@example.com` })),
  });
  await db.channelAdapter.deleteMany({ where: { token: ADAPTER_TOKEN } });
  await db.channelAdapter.create({
    data: { token: ADAPTER_TOKEN, name: P, kind: "instance" },
  });
  integrationId = (
    await db.channelIntegration.create({
      data: {
        organizationId: ORG,
        provider: "slack",
        externalId: TEAM,
        name: "Health Slack",
        createdByUserId: OWNER,
      },
      select: { id: true },
    })
  ).id;
  otherIntegrationId = (
    await db.channelIntegration.create({
      data: {
        organizationId: OTHER_ORG,
        provider: "slack",
        externalId: `${TEAM}OTHER`,
        name: "Other Slack",
        createdByUserId: STRANGER,
      },
      select: { id: true },
    })
  ).id;
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
  authErrors.clear();
  probed.length = 0;
  health.resetDailyCheckForTests();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.channelAdapter.deleteMany({ where: { token: ADAPTER_TOKEN } });
  slackServer?.close();
});

const alertsAs = async (userId: string, headerWorkspace = WORKSPACE) => {
  currentSession = { id: userId, email: `${userId}@example.com` };
  try {
    return await app.request(`/v1/workspaces/${WORKSPACE}/channel-alerts`, {
      headers: { "x-workspace-id": headerWorkspace },
    });
  } finally {
    currentSession = null;
  }
};

describe.skipIf(!PROOF_URL)("lost-connection alerts", () => {
  it("lists only disabled presences in this workspace, newest first", async () => {
    const older = await seedAgent("older");
    const newer = await seedAgent("newer");
    const live = await seedAgent("live");
    const o = await seedPresence(older, "disabled");
    const n = await seedPresence(newer, "disabled");
    await seedPresence(live, "active");
    // Two rows written back to back can share a millisecond: pin distinct
    // loss times so "newest first" is what is being checked.
    const t = Date.now();
    await db.agentChannel.update({
      where: { id: o.id },
      data: { updatedAt: new Date(t - 60_000) },
    });
    await db.agentChannel.update({
      where: { id: n.id },
      data: { updatedAt: new Date(t - 1_000) },
    });
    // Planted in ANOTHER org's workspace: must never appear here.
    const foreign = await seedAgent("foreign", OTHER_WORKSPACE);
    await seedPresence(foreign, "disabled", undefined, otherIntegrationId);

    const items = await health.listLostChannelConnections(WORKSPACE);
    expect(items.map((i) => i.agentId)).toEqual([newer, older]);
    expect(items[0]).toEqual({
      id: expect.any(String),
      agentId: newer,
      agentName: "Agent newer",
      provider: "slack",
      lostAt: expect.any(String),
    });
  });

  it("reaches every member of the workspace, and nobody outside it", async () => {
    const lost = await seedAgent("fenced");
    await seedPresence(lost, "disabled");

    for (const viewer of [OWNER, MEMBER]) {
      const res = await alertsAs(viewer);
      expect(res.status).toBe(200);
      const { items } = (await res.json()) as { items: { agentId: string }[] };
      expect(items.map((i) => i.agentId)).toEqual([lost]);
    }
    // A foreign tenant: an owner of ANOTHER org naming this workspace.
    const res = await alertsAs(STRANGER);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain(lost);
    // The same stranger scoped to their OWN workspace by the header, with
    // this one in the path: the route's own check refuses the path.
    const swapped = await alertsAs(STRANGER, OTHER_WORKSPACE);
    expect(swapped.status).toBeGreaterThanOrEqual(400);
    expect(await swapped.text()).not.toContain(lost);
  });

  it("with roles enforced (cloud, licensed self-host): a member with access sees it, one without does not", async () => {
    const lost = await seedAgent("rbac");
    await seedPresence(lost, "disabled");
    const env = await import("../../lib/env");
    const { getUserRole, eeWorkspaceAccessChecker } =
      await import("../../ee/services/authorization-service");
    const { initWorkspaceAccessChecker } =
      await import("../../providers/access-checker");
    const before = env.CAPS.rbac;
    Object.defineProperty(env.CAPS, "rbac", {
      value: true,
      configurable: true,
    });
    providers.initRoleResolver({ getUserRole });
    initWorkspaceAccessChecker(eeWorkspaceAccessChecker);
    try {
      // A plain member with no binding to this workspace: invisible.
      const outsider = await alertsAs(MEMBER);
      expect(outsider.status).toBeGreaterThanOrEqual(400);
      expect(await outsider.text()).not.toContain(lost);

      // The same member once given access sees the alert, no admin role.
      await db.workspaceAccess.create({
        data: { workspaceId: WORKSPACE, userId: MEMBER, role: "member" },
      });
      const member = await alertsAs(MEMBER);
      expect(member.status).toBe(200);
      const { items } = (await member.json()) as {
        items: { agentId: string }[];
      };
      expect(items.map((i) => i.agentId)).toEqual([lost]);

      const owner = await alertsAs(OWNER);
      expect(owner.status).toBe(200);
    } finally {
      await db.workspaceAccess.deleteMany({
        where: { workspaceId: WORKSPACE, userId: MEMBER },
      });
      Object.defineProperty(env.CAPS, "rbac", {
        value: before,
        configurable: true,
      });
      providers.initRoleResolver(null);
      initWorkspaceAccessChecker(null);
    }
  });
});

describe.skipIf(!PROOF_URL)("checkChannelConnectionsDaily", () => {
  it("flips a revoked token, leaves a rate-limited one live, survives an unreadable credential", async () => {
    const revoked = await seedAgent("revoked");
    const limited = await seedAgent("limited");
    const broken = await seedAgent("broken");
    const paused = await seedAgent("paused");
    const r = await seedPresence(revoked, "active", "xoxb-revoked");
    const l = await seedPresence(limited, "active", "xoxb-limited");
    const b = await seedPresence(broken, "active");
    const p = await seedPresence(paused, "needs_attention", "xoxb-paused");
    await db.agentChannel.update({
      where: { id: b.id },
      data: { credentials: "not-a-ciphertext" },
    });
    authErrors.set("xoxb-revoked", "token_revoked");
    authErrors.set("xoxb-paused", "account_inactive");
    authErrors.set("xoxb-limited", "ratelimited");

    const result = await health.checkChannelConnectionsDaily();
    expect(result).toMatchObject({ skipped: false, lost: 2 });
    expect(await status(r.id)).toBe("disabled");
    expect(await status(p.id)).toBe("disabled");
    expect(await status(l.id)).toBe("active");
    expect(await status(b.id)).toBe("active");

    const items = await health.listLostChannelConnections(WORKSPACE);
    expect(items.map((i) => i.agentId).sort()).toEqual(
      [revoked, paused].sort(),
    );
  });

  it("the adapter's hourly maintenance call runs it, end to end through the bell", async () => {
    const agent = await seedAgent("wired");
    await seedPresence(agent, "active", "xoxb-wired-dead");
    authErrors.set("xoxb-wired-dead", "invalid_auth");

    const res = await app.request("/v1/channel-adapter/rotate-integrations", {
      method: "POST",
      headers: { authorization: `Bearer ${ADAPTER_TOKEN}` },
    });
    expect(res.status).toBe(200);
    // The check runs detached from the response: wait for its effect.
    await vi.waitFor(
      async () =>
        expect(
          (await health.listLostChannelConnections(WORKSPACE)).map(
            (i) => i.agentId,
          ),
        ).toEqual([agent]),
      { timeout: 10_000 },
    );
    // And a user key never reaches that route.
    currentSession = { id: OWNER, email: `${OWNER}@example.com` };
    try {
      const asUser = await app.request(
        "/v1/channel-adapter/rotate-integrations",
        { method: "POST", headers: { "x-workspace-id": WORKSPACE } },
      );
      expect(asUser.status).toBe(401);
    } finally {
      currentSession = null;
    }
  });

  it("walks every live presence in batches, then waits a day for the next lap", async () => {
    const tokens: string[] = [];
    for (const name of ["a", "b", "c", "d", "e"]) {
      const token = `xoxb-lap-${name}`;
      tokens.push(token);
      await seedPresence(await seedAgent(`lap-${name}`), "active", token);
    }
    const ours = () => probed.filter((t) => tokens.includes(t));
    const t0 = Date.now();

    // Batches of two: the lap takes three ticks, and no presence is skipped.
    expect(
      await health.checkChannelConnectionsDaily({ now: t0, batchSize: 2 }),
    ).toMatchObject({ skipped: false });
    await health.checkChannelConnectionsDaily({ now: t0 + 1, batchSize: 2 });
    await health.checkChannelConnectionsDaily({ now: t0 + 2, batchSize: 2 });
    await health.checkChannelConnectionsDaily({ now: t0 + 3, batchSize: 2 });
    expect(new Set(ours())).toEqual(new Set(tokens));
    expect(ours()).toHaveLength(tokens.length);

    // The lap is done: an hour later nothing runs.
    const hourLater = await health.checkChannelConnectionsDaily({
      now: t0 + 60 * 60 * 1000,
      batchSize: 2,
    });
    expect(hourLater.skipped).toBe(true);
    expect(ours()).toHaveLength(tokens.length);

    // A day later the next lap starts.
    const dayLater = await health.checkChannelConnectionsDaily({
      now: t0 + 24 * 60 * 60 * 1000 + 1,
      batchSize: 2,
    });
    expect(dayLater.skipped).toBe(false);
    expect(ours().length).toBeGreaterThan(tokens.length);
  });

  it("a lap ends on its last short batch, and overlapping ticks never probe twice", async () => {
    const tokens: string[] = [];
    for (const name of ["a", "b", "c"]) {
      const token = `xoxb-end-${name}`;
      tokens.push(token);
      await seedPresence(await seedAgent(`end-${name}`), "active", token);
    }
    const ours = () => probed.filter((t) => tokens.includes(t));
    const t0 = Date.now();

    // Two ticks arriving together: the second stands aside.
    const [first, second] = await Promise.all([
      health.checkChannelConnectionsDaily({ now: t0, batchSize: 50 }),
      health.checkChannelConnectionsDaily({ now: t0, batchSize: 50 }),
    ]);
    expect([first.skipped, second.skipped].sort()).toEqual([false, true]);
    expect(ours()).toHaveLength(tokens.length);

    // That batch was short, so the lap is over: the next tick idles.
    const next = await health.checkChannelConnectionsDaily({
      now: t0 + 1,
      batchSize: 50,
    });
    expect(next.skipped).toBe(true);
    expect(ours()).toHaveLength(tokens.length);
  });
});
