import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof.js";
import type { AgentEvent } from "@onecli/agent-protocol";

/**
 * Agent RUNS on REAL PostgreSQL. Laws:
 *  - a member sees their own direct runs and non-direct (eval, cron) runs,
 *    never a colleague's direct thread;
 *  - where roles are enforced, an org admin sees every run, and `getRun`
 *    flags a colleague's direct run as `viewedOthersDirect` (the route
 *    audits that read); without role enforcement there is no override;
 *  - "apps used" comes from the gateway log inside the turn window, LLM
 *    traffic excluded, and rows outside the window do not count;
 *  - another workspace's agent is NOT_FOUND (negative control).
 */

// Role enforcement is per edition: flip it per test, with the real
// membership-backed role resolver injected the way edition defaults do.
const caps = vi.hoisted(() => ({ rbac: true }));
vi.mock("../lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/env")>();
  return {
    ...actual,
    CAPS: {
      ...actual.CAPS,
      get rbac() {
        return caps.rbac;
      },
    },
  };
});

const PROOF_URL = proofDatabaseUrl();
const P = "arp-";
const ORG = `${P}org`;
const WS = `${P}ws`;
const OTHER_WS = `${P}ws-other`;
const OTHER_ORG = `${P}org-other`;
const USER_A = `${P}user-a`;
const USER_B = `${P}user-b`;

const setRole = (role: string, status = "active") =>
  db.organizationMember.update({
    where: { organizationId_userId: { organizationId: ORG, userId: USER_A } },
    data: { role, status },
  });

type Db = typeof import("@onecli/db").db;
type Runs = typeof import("./agent-runs-service");
let db: Db;
let runs: Runs;
let agentId = "";
let otherAgentId = "";
const turnIds: Record<string, string> = {};

const reset = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.requestLog.deleteMany({
    where: { workspaceId: { in: [WS, OTHER_WS] } },
  });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: { startsWith: P } },
  });
  await db.organizationMember.deleteMany({
    where: { organizationId: { startsWith: P } },
  });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
};

const at = (iso: string) => new Date(iso);

const seedTurn = async (
  key: string,
  opts: {
    direct: boolean;
    userId: string | null;
    source: string;
    message: string;
    start: string;
    end: string;
    answer?: string;
    tool?: { name: string; input: string; output: string };
    ownerId?: string;
  },
) => {
  const conversation = await db.conversation.create({
    data: {
      agentId,
      source: opts.source,
      direct: opts.direct,
      userId: opts.direct ? (opts.ownerId ?? opts.userId) : null,
    },
    select: { id: true },
  });
  const turn = await db.turn.create({
    data: {
      conversationId: conversation.id,
      source: opts.source,
      userId: opts.userId,
      message: opts.message,
      status: "done",
      createdAt: at(opts.start),
      startedAt: at(opts.start),
      finishedAt: at(opts.end),
    },
    select: { id: true },
  });
  // Stored exactly as the turn path writes them: the whole event as payload.
  const events: AgentEvent[] = [];
  if (opts.tool) {
    events.push(
      { type: "tool.started", callId: "c1", name: opts.tool.name },
      {
        type: "tool.finished",
        callId: "c1",
        name: opts.tool.name,
        input: opts.tool.input,
        output: opts.tool.output,
      },
    );
  }
  if (opts.answer) events.push({ type: "text", text: opts.answer });
  let seq = 0;
  for (const e of events) {
    seq += 1;
    await db.turnEvent.create({
      data: {
        conversationId: conversation.id,
        turnId: turn.id,
        seq,
        type: e.type,
        payload: { ...e },
      },
    });
  }
  await db.conversation.update({
    where: { id: conversation.id },
    data: { lastSeq: seq },
  });
  turnIds[key] = turn.id;
};

const log = (provider: string, host: string, iso: string) =>
  db.requestLog.create({
    data: {
      workspaceId: WS,
      agentId,
      method: "POST",
      host,
      path: "/private?question=unrelated-sensitive-text",
      provider,
      status: 200,
      latencyMs: 10,
      injectionCount: 1,
      createdAt: at(iso),
    },
  });

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  ({ db } = await import("@onecli/db"));
  runs = await import("./agent-runs-service");
  const { initRoleResolver } = await import("../providers");
  const { getUserRole } = await import("../ee/services/authorization-service");
  initRoleResolver({ getUserRole });
  await reset();
  await db.organization.createMany({
    data: [ORG, OTHER_ORG].map((id) => ({ id, name: id, slug: id })),
  });
  await db.workspace.createMany({
    data: [
      { id: WS, name: "Runs", organizationId: ORG },
      { id: OTHER_WS, name: "Other", organizationId: OTHER_ORG },
    ],
  });
  await db.user.createMany({
    data: [USER_A, USER_B].map((id) => ({
      id,
      email: `${id}@example.com`,
      externalAuthId: id,
    })),
  });
  await db.organizationMember.createMany({
    data: [USER_A, USER_B].map((userId) => ({
      organizationId: ORG,
      userId,
      userEmail: `${userId}@example.com`,
      role: "member",
    })),
  });
  const mk = async (ws: string, suffix: string) =>
    (
      await db.agent.create({
        data: {
          workspaceId: ws,
          name: `agent ${suffix}`,
          identifier: `${P}${suffix}`,
          accessToken: `aoc_${P}${suffix}`,
          kind: "hosted",
          harness: "fake",
        },
        select: { id: true },
      })
    ).id;
  agentId = await mk(WS, "a");
  otherAgentId = await mk(OTHER_WS, "b");

  await seedTurn("aDirect", {
    direct: true,
    userId: USER_A,
    source: "web",
    message: "A: what was Q1 revenue?",
    start: "2026-09-01T10:00:00Z",
    end: "2026-09-01T10:00:30Z",
    answer: "$3.2M",
    tool: {
      name: "bash",
      input: '{"command":"curl https://api.notion.com/v1/search"}',
      output: "[[3200000]]",
    },
  });
  await seedTurn("bDirect", {
    direct: true,
    userId: USER_B,
    source: "slack",
    message: "B: private question",
    start: "2026-09-01T11:00:00Z",
    end: "2026-09-01T11:00:10Z",
    answer: "ok",
  });
  await seedTurn("eval", {
    direct: false,
    userId: USER_B,
    source: "eval",
    message: "Eval: how many customers?",
    start: "2026-09-01T12:00:00Z",
    end: "2026-09-01T12:00:20Z",
    answer: "42",
  });
  await seedTurn("guest", {
    direct: false,
    userId: null,
    source: "slack",
    message: "guest private DM",
    start: "2026-09-01T10:00:05Z",
    end: "2026-09-01T10:00:25Z",
  });
  const integration = await db.channelIntegration.create({
    data: {
      organizationId: ORG,
      provider: "slack",
      externalId: `${P}team`,
      name: "Runs guest test",
      createdByUserId: USER_A,
    },
  });
  const channel = await db.agentChannel.create({
    data: {
      agentId,
      integrationId: integration.id,
      provider: "slack",
      externalId: `${P}app`,
      transport: "socket",
    },
  });
  const guest = await db.turn.findUniqueOrThrow({
    where: { id: turnIds.guest },
  });
  await db.channelThreadLink.create({
    data: {
      agentChannelId: channel.id,
      conversationId: guest.conversationId,
      externalThreadId: `${P}dm`,
      kind: "direct",
    },
  });
  // Gateway rows: notion + docs inside A's window, LLM traffic inside it
  // (excluded), and a hubspot call OUTSIDE every window (must not count).
  await log("notion", "api.notion.com", "2026-09-01T10:00:10Z");
  await log("docs", "docs.example.com", "2026-09-01T10:00:20Z");
  await log("anthropic", "api.anthropic.com", "2026-09-01T10:00:15Z");
  await log("hubspot", "api.hubapi.com", "2026-09-01T10:05:00Z");
});

afterAll(async () => {
  if (!PROOF_URL) return;
  const { initRoleResolver } = await import("../providers");
  initRoleResolver(null);
  await reset();
});

describe.skipIf(!PROOF_URL)("agent runs (pg)", () => {
  it("compound cursors traverse tied timestamps exactly once", async () => {
    const conversation = await db.conversation.create({
      data: { agentId, source: "cursor-proof" },
    });
    const tiedAt = at("2026-09-02T00:00:00Z");
    const ids = ["a", "b", "c", "d", "e"].map((id) => `${P}cursor-${id}`);
    await db.turn.createMany({
      data: ids.map((id) => ({
        id,
        conversationId: conversation.id,
        source: "cursor-proof",
        status: "done",
        message: id,
        createdAt: tiedAt,
        startedAt: tiedAt,
        finishedAt: tiedAt,
      })),
    });
    try {
      const seen: string[] = [];
      let before: string | undefined;
      for (let i = 0; i < 4; i++) {
        const page = await runs.listRuns(WS, ORG, USER_A, agentId, {
          source: "cursor-proof",
          limit: 2,
          before,
        });
        seen.push(...page.runs.map((r) => r.turnId));
        if (!page.nextBefore) break;
        before = page.nextBefore;
      }
      expect(seen).toEqual([...ids].reverse());
      expect(new Set(seen).size).toBe(ids.length);
    } finally {
      await db.conversation.delete({ where: { id: conversation.id } });
    }
  });

  it("app-filter cursors advance past the scanned tied rows even when no rows match", async () => {
    await setRole("admin");
    const conversation = await db.conversation.create({
      data: { agentId, source: "app-cursor-proof" },
    });
    const tiedAt = at("2026-09-03T00:00:00Z");
    const oldAt = at("2026-09-02T23:00:00Z");
    const ids = Array.from(
      { length: 101 },
      (_, i) => `${P}scan-${String(i).padStart(3, "0")}`,
    );
    await db.turn.createMany({
      data: ids.map((id, i) => ({
        id,
        conversationId: conversation.id,
        source: "app-cursor-proof",
        status: "done",
        message: id,
        createdAt: tiedAt,
        startedAt: i === 0 ? oldAt : tiedAt,
        finishedAt: i === 0 ? oldAt : tiedAt,
      })),
    });
    const evidence = await log(
      "cursor-app",
      "cursor.example.com",
      oldAt.toISOString(),
    );
    try {
      const first = await runs.listRuns(WS, ORG, USER_A, agentId, {
        source: "app-cursor-proof",
        app: "cursor-app",
        limit: 1,
      });
      expect(first.runs).toEqual([]);
      expect(first.nextBefore).toBe(`${tiedAt.toISOString()}~${ids[1]}`);
      const second = await runs.listRuns(WS, ORG, USER_A, agentId, {
        source: "app-cursor-proof",
        app: "cursor-app",
        before: first.nextBefore!,
      });
      expect(second.runs.map((r) => r.turnId)).toEqual([ids[0]]);
      expect(second.nextBefore).toBeNull();
    } finally {
      await db.requestLog.delete({ where: { id: evidence.id } });
      await db.conversation.delete({ where: { id: conversation.id } });
    }
  });
  beforeEach(async () => {
    caps.rbac = true;
    await setRole("member");
  });
  it("member: own direct + non-direct runs, never a colleague's direct thread", async () => {
    const res = await runs.listRuns(WS, ORG, USER_A, agentId);
    const ids = res.runs.map((r) => r.turnId);
    expect(ids).toContain(turnIds.aDirect);
    expect(ids).toContain(turnIds.eval);
    expect(ids).not.toContain(turnIds.bDirect);
    expect(res.isAdmin).toBe(false);
    await expect(
      runs.getRun(WS, ORG, USER_A, agentId, turnIds.bDirect!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("admin: sees every run and a colleague's direct read is flagged", async () => {
    await setRole("admin");
    const res = await runs.listRuns(WS, ORG, USER_A, agentId);
    expect(res.runs.map((r) => r.turnId)).toContain(turnIds.bDirect);
    expect(res.viewedOthersDirect.map((r) => r.turnId)).toEqual([
      turnIds.bDirect,
    ]);
    const other = await runs.getRun(WS, ORG, USER_A, agentId, turnIds.bDirect!);
    expect(other.viewedOthersDirect).toBe(true);
    const own = await runs.getRun(WS, ORG, USER_A, agentId, turnIds.aDirect!);
    expect(own.viewedOthersDirect).toBe(false);
    const evalRun = await runs.getRun(WS, ORG, USER_A, agentId, turnIds.eval!);
    expect(evalRun.viewedOthersDirect).toBe(false);
  });

  it("apps used come from the gateway window; LLM and out-of-window rows excluded", async () => {
    await setRole("owner");
    const { run } = await runs.getRun(
      WS,
      ORG,
      USER_A,
      agentId,
      turnIds.aDirect!,
    );
    expect(run.appsUsed.sort()).toEqual(["docs", "notion"]);
    expect(run.appCalls.map((a) => a.provider)).not.toContain("anthropic");
    expect(run.appCalls.map((a) => a.provider)).not.toContain("hubspot");
    expect(run.appAttribution).toBe("agent_time_window");
    expect(JSON.stringify(run)).not.toContain("unrelated-sensitive-text");
    expect(run.tools).toEqual([
      {
        callId: "c1",
        name: "bash",
        input: '{"command":"curl https://api.notion.com/v1/search"}',
        output: "[[3200000]]",
        isError: false,
      },
    ]);
    expect(run.answer).toBe("$3.2M");
  });

  it("filters: by source, and by app", async () => {
    await setRole("admin");
    const evals = await runs.listRuns(WS, ORG, USER_A, agentId, {
      source: "eval",
    });
    expect(evals.runs.map((r) => r.turnId)).toEqual([turnIds.eval]);
    const byApp = await runs.listRuns(WS, ORG, USER_A, agentId, {
      app: "notion",
    });
    expect(byApp.runs.map((r) => r.turnId)).toEqual([turnIds.aDirect]);
  });

  it("another workspace's agent is NOT_FOUND", async () => {
    await expect(
      runs.listRuns(WS, ORG, USER_A, otherAgentId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each(["member", "admin", "owner"])(
    "excludes sourced guest DMs for %s",
    async (role) => {
      await setRole(role);
      const res = await runs.listRuns(WS, ORG, USER_A, agentId);
      expect(res.runs.map((r) => r.turnId)).not.toContain(turnIds.guest);
      await expect(
        runs.getRun(WS, ORG, USER_A, agentId, turnIds.guest!),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    },
  );

  it("without role enforcement an owner is a member: no private override, no gateway metadata", async () => {
    caps.rbac = false;
    await setRole("owner");
    const res = await runs.listRuns(WS, ORG, USER_A, agentId);
    expect(res.isAdmin).toBe(false);
    expect(res.runs.map((r) => r.turnId)).not.toContain(turnIds.bDirect);
    expect(res.viewedOthersDirect).toEqual([]);
    expect(res.appEvidenceWithheld).toBe(true);
    await expect(
      runs.getRun(WS, ORG, USER_A, agentId, turnIds.bDirect!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("withholds overlapping gateway metadata from a member, including app filters", async () => {
    const { run } = await runs.getRun(
      WS,
      ORG,
      USER_A,
      agentId,
      turnIds.aDirect!,
    );
    expect(run.appAttribution).toBe("withheld");
    expect(run.appsUsed).toEqual([]);
    expect(run.appCalls).toEqual([]);
    const filtered = await runs.listRuns(WS, ORG, USER_A, agentId, {
      app: "notion",
    });
    expect(filtered.runs).toEqual([]);
    expect(filtered.viewedOthersDirect).toEqual([]);
  });

  it("a suspended admin cannot widen private ownership", async () => {
    await setRole("admin", "suspended");
    const res = await runs.listRuns(WS, ORG, USER_A, agentId);
    expect(res.isAdmin).toBe(false);
    expect(res.runs.map((r) => r.turnId)).not.toContain(turnIds.bDirect);
    await expect(
      runs.getRun(WS, ORG, USER_A, agentId, turnIds.bDirect!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an unrelated org cannot supply the admin override for this workspace", async () => {
    await expect(
      runs.listRuns(WS, OTHER_ORG, USER_A, agentId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      runs.getRun(WS, OTHER_ORG, USER_A, agentId, turnIds.aDirect!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("private audit flags follow the conversation owner, not the turn author", async () => {
    await setRole("admin");
    const id = turnIds.bDirect!;
    await db.turn.update({ where: { id }, data: { userId: USER_A } });
    try {
      expect(
        (await runs.getRun(WS, ORG, USER_A, agentId, id)).viewedOthersDirect,
      ).toBe(true);
      expect(
        (await runs.listRuns(WS, ORG, USER_A, agentId)).viewedOthersDirect.map(
          (r) => r.turnId,
        ),
      ).toContain(id);
    } finally {
      await db.turn.update({ where: { id }, data: { userId: USER_B } });
    }
  });

  it("an orphaned channel conversation cannot become a public guest DM", async () => {
    const guest = await db.turn.findUniqueOrThrow({
      where: { id: turnIds.guest! },
    });
    const link = await db.channelThreadLink.findUniqueOrThrow({
      where: { conversationId: guest.conversationId },
    });
    await db.channelThreadLink.delete({ where: { id: link.id } });
    try {
      await setRole("admin");
      expect(
        (await runs.listRuns(WS, ORG, USER_A, agentId)).runs.map(
          (r) => r.turnId,
        ),
      ).not.toContain(guest.id);
      await expect(
        runs.getRun(WS, ORG, USER_A, agentId, guest.id),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await db.channelThreadLink.create({ data: link });
    }
  });

  it("purpose-scoped eval evidence works for members without exposing request metadata", async () => {
    await log("notion", "api.notion.com", "2026-09-01T12:00:10Z");
    const run = await runs.getEvalRunEvidence(
      WS,
      ORG,
      USER_B,
      agentId,
      turnIds.eval!,
      [],
    );
    expect(run).toEqual({
      answer: "42",
      appsUsed: ["notion"],
      appAttribution: "agent_time_window",
    });
    for (const [viewer, turnId] of [
      [USER_A, turnIds.eval!],
      [USER_A, turnIds.aDirect!],
      [USER_A, turnIds.guest!],
    ]) {
      await expect(
        runs.getEvalRunEvidence(WS, ORG, viewer!, agentId, turnId!, []),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("matches requested custom hosts even when gateway labels the host as a catalog provider", async () => {
    await log("github", "api.github.com", "2026-09-01T12:00:10Z");
    const run = await runs.getEvalRunEvidence(
      WS,
      ORG,
      USER_B,
      agentId,
      turnIds.eval!,
      ["host:api.github.com", "host:unrelated.example.com"],
    );
    expect(run.appsUsed).toContain("github");
    expect(run.appsUsed).toContain("host:api.github.com");
    expect(run.appsUsed).not.toContain("host:unrelated.example.com");
    expect(run.appAttribution).toBe("agent_time_window");
  });

  it("eval app evidence is withheld when a private turn overlaps", async () => {
    const other = await db.turn.findUniqueOrThrow({
      where: { id: turnIds.bDirect! },
    });
    await db.turn.update({
      where: { id: other.id },
      data: {
        startedAt: at("2026-09-01T12:00:01Z"),
        finishedAt: at("2026-09-01T12:00:15Z"),
      },
    });
    try {
      const run = await runs.getEvalRunEvidence(
        WS,
        ORG,
        USER_B,
        agentId,
        turnIds.eval!,
        ["host:data.example.com"],
      );
      expect(run).toEqual({
        answer: "42",
        appsUsed: [],
        appAttribution: "withheld",
      });
    } finally {
      await db.turn.update({
        where: { id: other.id },
        data: { startedAt: other.startedAt, finishedAt: other.finishedAt },
      });
    }
  });
});
