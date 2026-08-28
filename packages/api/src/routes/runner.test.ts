import { beforeEach, describe, expect, it, vi } from "vitest";

// The runner API's HTTP contract (hosted-agents step 3): token-family
// separation in BOTH directions, registration's accept/reject arms, the work
// poll's shape, and runner-fenced event application. The DB laws live in
// due-work.pg.test.ts; services are mocked here.

const RUNNER_TOKEN = "rnr_known-runner-token";
const ORG_KEY = "oc_org_test-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const roleHolder = vi.hoisted(() => ({ role: "owner" }));

const services = vi.hoisted(() => ({
  registerRunner: vi.fn(),
  heartbeatRunner: vi.fn(),
  listRunners: vi.fn(),
  getRunnerAvailability: vi.fn(),
  runnerSupportsAttachments: vi.fn(),
  planTurnAttachments: vi.fn(),
  sweepStalePendingAttachments: vi.fn(),
  getAttachmentBytesForRunner: vi.fn(),
  bindAttachmentsToTurn: vi.fn(),
  firstAttachmentName: vi.fn(),
  claimDueWork: vi.fn(),
  reclaimStaleTurns: vi.fn(),
  failStalledTurns: vi.fn(),
  releaseClaim: vi.fn(),
  waitForWork: vi.fn(),
  buildSandboxStartPayload: vi.fn(),
  applyRunnerEvent: vi.fn(),
  listRunnerSandboxes: vi.fn(),
  listMissingSandboxIds: vi.fn(),
  runnerUpdate: vi.fn(),
  buildTurnContext: vi.fn(),
  fireDueCrons: vi.fn(),
  fireDueWatches: vi.fn(),
  promoteParkedFollowUps: vi.fn(),
  expireWedgedFollowUps: vi.fn(),
  applyProcessState: vi.fn(),
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    runner: {
      findUnique: async ({ where }: { where: { token: string } }) =>
        where.token === RUNNER_TOKEN ? { id: "r-1", name: "laptop" } : null,
      update: services.runnerUpdate,
    },
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === ORG_KEY
          ? { userId: "user-1", organizationId: "org-1", scope: "organization" }
          : null,
      findFirst: async () => null,
    },
    user: { findUnique: async () => ({ email: "admin@example.com" }) },
    organizationMember: {
      findUnique: async () => ({
        organizationId: "org-1",
        userId: "user-1",
        role: roleHolder.role,
      }),
    },
    workspace: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === "p1" ? { id: "p1" } : null,
    },
    auditLog: { create: async () => ({}) },
  },
}));

vi.mock("../services/runner-service", () => ({
  registerRunner: services.registerRunner,
  heartbeatRunner: services.heartbeatRunner,
  listRunners: services.listRunners,
  getRunnerAvailability: services.getRunnerAvailability,
  runnerSupportsAttachments: services.runnerSupportsAttachments,
}));

vi.mock("../services/attachment-service", () => ({
  planTurnAttachments: services.planTurnAttachments,
  sweepStalePendingAttachments: services.sweepStalePendingAttachments,
  getAttachmentBytesForRunner: services.getAttachmentBytesForRunner,
  // turn-service imports these from the same module (bind-in-transaction);
  // the mock must carry them or the whole module graph fails to load.
  attachmentMetaSelect: {
    id: true,
    name: true,
    mimeType: true,
    sizeBytes: true,
    status: true,
  },
  bindAttachmentsToTurn: services.bindAttachmentsToTurn,
  firstAttachmentName: services.firstAttachmentName,
}));

vi.mock("../services/due-work", () => ({
  claimDueWork: services.claimDueWork,
  reclaimStaleTurns: services.reclaimStaleTurns,
  failStalledTurns: services.failStalledTurns,
  expireWedgedFollowUps: services.expireWedgedFollowUps,
  releaseClaim: services.releaseClaim,
  waitForWork: services.waitForWork,
}));

vi.mock("../services/follow-up-service", () => ({
  promoteParkedFollowUps: services.promoteParkedFollowUps,
}));

vi.mock("../services/sandbox-service", () => ({
  buildSandboxStartPayload: services.buildSandboxStartPayload,
  applyRunnerEvent: services.applyRunnerEvent,
  listRunnerSandboxes: services.listRunnerSandboxes,
  listMissingSandboxIds: services.listMissingSandboxIds,
  requestSandboxRespawn: vi.fn(),
}));

vi.mock("../services/turn-context-service", () => ({
  buildTurnContext: services.buildTurnContext,
}));

vi.mock("../services/cron-fire-service", () => ({
  fireDueCrons: services.fireDueCrons,
}));

// The poll's ssh-session sweep + the instance route's availability posture
// (sandbox-platform step 5) — mocked so the route graph loads without the
// ssh service; the sweep is non-fatal like every sweep.
vi.mock("../services/ssh-service", () => ({
  sweepSshSessions: vi.fn(async () => {}),
  sshAvailable: () => false,
}));

vi.mock("../services/watch-fire-service", () => ({
  fireDueWatches: services.fireDueWatches,
}));

vi.mock("../services/sandbox-process-service", () => ({
  applyProcessState: services.applyProcessState,
}));

const { createApiApp } = await import("../app");

const app = createApiApp({ getSession: async () => null });

const RUNNER_AUTH = {
  authorization: `Bearer ${RUNNER_TOKEN}`,
  "content-type": "application/json",
};

const CAPABILITIES = {
  maxSandboxes: 4,
  backend: "docker",
  homeDurability: "resident" as const,
};

const PAYLOAD = {
  env: { HTTPS_PROXY: "http://x:aoc_t@gateway:10255" },
  files: [{ containerPath: "/tmp/ca.pem", content: "PEM" }],
  warnings: [],
};

beforeEach(() => {
  roleHolder.role = "owner";
  for (const fn of Object.values(services)) fn.mockReset();
  services.runnerUpdate.mockResolvedValue({});
  services.claimDueWork.mockResolvedValue([]);
  services.buildTurnContext.mockResolvedValue(null);
  // The sweeps return what they killed so the poll can settle it.
  services.reclaimStaleTurns.mockResolvedValue([]);
  services.failStalledTurns.mockResolvedValue([]);
  services.fireDueCrons.mockResolvedValue(0);
  services.fireDueWatches.mockResolvedValue(0);
  services.promoteParkedFollowUps.mockResolvedValue(0);
  services.expireWedgedFollowUps.mockResolvedValue(0);
  services.applyProcessState.mockResolvedValue(undefined);
  // Attachments default OFF: existing turn-dispatch tests must see the bare
  // turn shape they assert. The attachment path has its own cases below.
  services.runnerSupportsAttachments.mockResolvedValue(false);
  services.planTurnAttachments.mockResolvedValue({ manifest: [], note: null });
  services.sweepStalePendingAttachments.mockResolvedValue(0);
  services.waitForWork.mockResolvedValue(undefined);
  services.listRunnerSandboxes.mockResolvedValue([]);
  services.getRunnerAvailability.mockResolvedValue({
    registered: false,
    online: false,
  });
  services.listRunners.mockResolvedValue([]);
});

describe("token-family separation", () => {
  it("refuses a user API key on the runner surface", async () => {
    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ORG_KEY}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(services.claimDueWork).not.toHaveBeenCalled();
  });

  it("refuses a runner token on the general /v1 surface", async () => {
    const res = await app.request("/v1/agents", {
      headers: {
        authorization: `Bearer ${RUNNER_TOKEN}`,
        "x-workspace-id": "p1",
      },
    });
    expect(res.status).toBe(401);
  });

  it("refuses an unknown runner token", async () => {
    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: {
        authorization: "Bearer rnr_not-a-real-token",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("refuses a missing Authorization header", async () => {
    const res = await app.request("/v1/runner/work", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("gives every refusal the same hint-free body", async () => {
    const headerSets: Array<Record<string, string>> = [
      { authorization: "Bearer rnr_unknown" },
      { authorization: `Bearer ${ORG_KEY}` },
      {},
    ];
    const bodies = await Promise.all(
      headerSets.map(async (headers) => {
        const res = await app.request("/v1/runner/sandboxes", { headers });
        return res.json();
      }),
    );
    expect(bodies).toEqual([
      { error: "Unauthorized" },
      { error: "Unauthorized" },
      { error: "Unauthorized" },
    ]);
  });
});

describe("POST /v1/runner/register", () => {
  it("registers with a valid token and capabilities", async () => {
    services.registerRunner.mockResolvedValue({ ok: true, runnerId: "r-1" });
    const res = await app.request("/v1/runner/register", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({ name: "laptop", capabilities: CAPABILITIES }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runnerId: "r-1" });
    expect(services.registerRunner).toHaveBeenCalledWith({
      token: RUNNER_TOKEN,
      name: "laptop",
      capabilities: CAPABILITIES,
    });
  });

  it("401s when the service refuses the token", async () => {
    services.registerRunner.mockResolvedValue({ ok: false });
    const res = await app.request("/v1/runner/register", {
      method: "POST",
      headers: {
        authorization: "Bearer rnr_unanchored",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "laptop", capabilities: CAPABILITIES }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a non-rnr_ token before touching the service", async () => {
    const res = await app.request("/v1/runner/register", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ORG_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "laptop", capabilities: CAPABILITIES }),
    });
    expect(res.status).toBe(401);
    expect(services.registerRunner).not.toHaveBeenCalled();
  });

  it("400s on an invalid body", async () => {
    const res = await app.request("/v1/runner/register", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({ name: "laptop" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("the stale-turn sweep runs on the poll", () => {
  // There is no background loop in the control plane (§3.3), so the poll is
  // the only regular tick — an unwired sweep is a sweep that never runs, and
  // the active-turn index would leave hung conversations blocked for good.
  it("sweeps before claiming", async () => {
    await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({ wait: 0 }),
    });
    expect(services.reclaimStaleTurns).toHaveBeenCalled();
    // The liveness arm rides the same tick.
    expect(services.failStalledTurns).toHaveBeenCalled();
  });

  it("still dispatches when the sweep fails", async () => {
    // The sweep is a recovery path; losing a pass must never stop dispatch.
    services.reclaimStaleTurns.mockRejectedValue(new Error("db blip"));
    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({ wait: 0 }),
    });
    expect(res.status).toBe(200);
    expect(services.claimDueWork).toHaveBeenCalled();
  });
});

describe("POST /v1/runner/work", () => {
  it("returns an empty list when nothing is due and wait is 0", async () => {
    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({ wait: 0 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect(services.claimDueWork).toHaveBeenCalledWith("r-1", 5);
  });

  it("composes a start payload for a claimed start", async () => {
    services.claimDueWork.mockResolvedValueOnce([
      { kind: "start", sandboxId: "sb-1", agentId: "ag-1" },
    ]);
    services.buildSandboxStartPayload.mockResolvedValue({
      ok: true,
      agentId: "ag-1",
      payload: PAYLOAD,
    });

    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({}),
    });

    expect(await res.json()).toEqual({
      items: [
        {
          kind: "sandbox.start",
          sandboxId: "sb-1",
          agentId: "ag-1",
          payload: PAYLOAD,
        },
      ],
    });
    expect(services.buildSandboxStartPayload).toHaveBeenCalledWith(
      "sb-1",
      "r-1",
    );
  });

  it("releases the claim when the payload cannot be composed", async () => {
    services.claimDueWork.mockResolvedValueOnce([
      { kind: "start", sandboxId: "sb-gone", agentId: "ag-gone" },
    ]);
    services.buildSandboxStartPayload.mockResolvedValue({
      ok: false,
      reason: "unavailable",
    });

    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({ wait: 0 }),
    });

    expect(await res.json()).toEqual({ items: [] });
    expect(services.releaseClaim).toHaveBeenCalledWith("sb-gone", "r-1");
  });

  it("a delivered turn carries the memory context when the builder has one", async () => {
    services.claimDueWork.mockResolvedValueOnce([
      {
        kind: "turn",
        turnId: "t-1",
        conversationId: "conv-1",
        sandboxId: "sb-1",
        agentId: "ag-1",
        message: "what is our staging url?",
        resumeSessionRef: null,
      },
    ]);
    services.buildTurnContext.mockResolvedValue("[Your memory — …]");

    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({}),
    });

    expect(await res.json()).toEqual({
      items: [
        {
          kind: "turn.deliver",
          sandboxId: "sb-1",
          conversationId: "conv-1",
          turnId: "t-1",
          message: "what is our staging url?",
          context: "[Your memory — …]",
        },
      ],
    });
    // The composer needs the turn's own coordinates now: the human-only
    // continuity bridge is windowed to this turn's moment (conversationId +
    // turnId), on top of the agent's memory.
    expect(services.buildTurnContext).toHaveBeenCalledWith(
      "ag-1",
      "conv-1",
      "t-1",
      "what is our staging url?",
    );
  });

  it("omits the context key entirely when the builder returns null", async () => {
    services.claimDueWork.mockResolvedValueOnce([
      {
        kind: "turn",
        turnId: "t-1",
        conversationId: "conv-1",
        sandboxId: "sb-1",
        agentId: "ag-1",
        message: "hi",
        resumeSessionRef: "sess-1",
      },
    ]);

    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({}),
    });

    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items[0]).not.toHaveProperty("context");
    expect(body.items[0]?.resumeSessionRef).toBe("sess-1");
  });

  it("a throwing context builder never blocks the turn — memory flavors, never gates", async () => {
    services.claimDueWork.mockResolvedValueOnce([
      {
        kind: "turn",
        turnId: "t-1",
        conversationId: "conv-1",
        sandboxId: "sb-1",
        agentId: "ag-1",
        message: "hi",
        resumeSessionRef: null,
      },
    ]);
    services.buildTurnContext.mockRejectedValue(new Error("db hiccup"));

    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({}),
    });

    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.kind).toBe("turn.deliver");
    expect(body.items[0]).not.toHaveProperty("context");
  });

  it("attaches the manifest + note for a CAPABLE runner and folds the note into context", async () => {
    services.claimDueWork.mockResolvedValueOnce([
      {
        kind: "turn",
        turnId: "t-1",
        conversationId: "conv-1",
        sandboxId: "sb-1",
        agentId: "ag-1",
        message: "what is this?",
        resumeSessionRef: null,
      },
    ]);
    services.runnerSupportsAttachments.mockResolvedValue(true);
    services.buildTurnContext.mockResolvedValue("[memory]");
    const manifest = [
      {
        id: "att-1",
        path: "attachments/t-1/photo.png",
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 3,
        sha256: "a".repeat(64),
      },
    ];
    services.planTurnAttachments.mockResolvedValue({
      manifest,
      note: "The user attached files…",
    });

    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({}),
    });

    const body = (await res.json()) as { items: Record<string, unknown>[] };
    const item = body.items[0]!;
    expect(item.kind).toBe("turn.deliver");
    expect(item.attachments).toEqual(manifest);
    // Note LEADS the context (the files belong to this message), memory follows.
    expect(item.context).toBe("The user attached files…\n\n[memory]");
  });

  it("ships a turn BARE for a runner that did not advertise attachments — no manifest, no note", async () => {
    services.claimDueWork.mockResolvedValueOnce([
      {
        kind: "turn",
        turnId: "t-1",
        conversationId: "conv-1",
        sandboxId: "sb-1",
        agentId: "ag-1",
        message: "what is this?",
        resumeSessionRef: null,
      },
    ]);
    // Default mock: runnerSupportsAttachments → false.
    services.buildTurnContext.mockResolvedValue(null);

    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({}),
    });

    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items[0]).not.toHaveProperty("attachments");
    expect(body.items[0]).not.toHaveProperty("context");
    expect(services.planTurnAttachments).not.toHaveBeenCalled();
  });

  it("passes a stop through with its containerRef", async () => {
    services.claimDueWork.mockResolvedValueOnce([
      { kind: "stop", sandboxId: "sb-2", containerRef: "cont-2" },
    ]);
    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({}),
    });
    expect(await res.json()).toEqual({
      items: [
        { kind: "sandbox.stop", sandboxId: "sb-2", containerRef: "cont-2" },
      ],
    });
  });

  it("answers immediately when work was due but none could be composed", async () => {
    // Otherwise a whole-deployment condition (no CA yet) would make every
    // held poll re-claim and re-release the same rows once a second.
    services.claimDueWork.mockResolvedValue([
      { kind: "start", sandboxId: "sb-x", agentId: "ag-x" },
    ]);
    services.buildSandboxStartPayload.mockResolvedValue({
      ok: false,
      reason: "unavailable",
    });

    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({ wait: 25 }),
    });

    expect(await res.json()).toEqual({ items: [] });
    expect(services.claimDueWork).toHaveBeenCalledTimes(1);
    expect(services.waitForWork).not.toHaveBeenCalled();
  });

  it("rejects a wait beyond the poll ceiling", async () => {
    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({ wait: 90 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/runner/events", () => {
  it("applies each event under the AUTHENTICATED runner id", async () => {
    const res = await app.request("/v1/runner/events", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({
        events: [
          { kind: "sandbox.status", sandboxId: "sb-1", status: "starting" },
          { kind: "supervisor.ready", sandboxId: "sb-1" },
        ],
      }),
    });
    expect(res.status).toBe(204);
    expect(services.applyRunnerEvent).toHaveBeenNthCalledWith(1, "r-1", {
      kind: "sandbox.status",
      sandboxId: "sb-1",
      status: "starting",
    });
    expect(services.applyRunnerEvent).toHaveBeenNthCalledWith(2, "r-1", {
      kind: "supervisor.ready",
      sandboxId: "sb-1",
    });
  });

  it("400s on an unknown status rather than writing it", async () => {
    const res = await app.request("/v1/runner/events", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({
        events: [
          { kind: "sandbox.status", sandboxId: "sb-1", status: "haunted" },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(services.applyRunnerEvent).not.toHaveBeenCalled();
  });

  it("routes a process.state event to its own service under the runner id (step 10)", async () => {
    const process = {
      ref: "p-1",
      command: "sleep 5",
      status: "running",
      startedAt: "2026-08-08T00:00:00.000Z",
      watches: [],
    };
    const res = await app.request("/v1/runner/events", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({
        events: [
          {
            kind: "process.state",
            sandboxId: "sb-1",
            containerRef: "cont-1",
            process,
          },
        ],
      }),
    });
    expect(res.status).toBe(204);
    // Its OWN service, not applyRunnerEvent, and fenced by the runner id.
    expect(services.applyProcessState).toHaveBeenCalledWith("r-1", {
      kind: "process.state",
      sandboxId: "sb-1",
      containerRef: "cont-1",
      process,
    });
    expect(services.applyRunnerEvent).not.toHaveBeenCalled();
  });
});

describe("the watch fire pass runs on the poll (step 10)", () => {
  it("fires watches, and a failing pass never stops dispatch", async () => {
    services.fireDueWatches.mockRejectedValue(new Error("sweep blip"));
    const res = await app.request("/v1/runner/work", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({ wait: 0 }),
    });
    expect(res.status).toBe(200);
    expect(services.fireDueWatches).toHaveBeenCalled();
    expect(services.claimDueWork).toHaveBeenCalled();
  });
});

describe("heartbeat + sandboxes", () => {
  it("heartbeats with an optional capability refresh", async () => {
    const res = await app.request("/v1/runner/heartbeat", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({ capabilities: CAPABILITIES }),
    });
    expect(res.status).toBe(204);
    expect(services.heartbeatRunner).toHaveBeenCalledWith("r-1", CAPABILITIES);
  });

  it("lists only the authenticated runner's sandboxes, with statuses", async () => {
    services.listRunnerSandboxes.mockResolvedValue([
      { id: "sb-1", status: "running" },
      { id: "sb-2", status: "stopped" },
    ]);
    const res = await app.request("/v1/runner/sandboxes", {
      headers: { authorization: `Bearer ${RUNNER_TOKEN}` },
    });
    expect(await res.json()).toEqual({
      sandboxIds: ["sb-1", "sb-2"],
      statuses: { "sb-1": "running", "sb-2": "stopped" },
    });
    expect(services.listRunnerSandboxes).toHaveBeenCalledWith("r-1");
  });
});

describe("POST /v1/runner/sandboxes/check (the orphan sweep's authority)", () => {
  it("answers which of the asked ids exist nowhere", async () => {
    services.listMissingSandboxIds.mockResolvedValue(["sb-gone"]);
    const res = await app.request("/v1/runner/sandboxes/check", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({ sandboxIds: ["sb-gone", "sb-alive"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ missing: ["sb-gone"] });
    expect(services.listMissingSandboxIds).toHaveBeenCalledWith([
      "sb-gone",
      "sb-alive",
    ]);
  });

  it("rejects a malformed body and an over-bound batch", async () => {
    const malformed = await app.request("/v1/runner/sandboxes/check", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: "{not json",
    });
    expect(malformed.status).toBe(400);

    const oversized = await app.request("/v1/runner/sandboxes/check", {
      method: "POST",
      headers: RUNNER_AUTH,
      body: JSON.stringify({
        sandboxIds: Array.from({ length: 501 }, (_, i) => `sb-${i}`),
      }),
    });
    expect(oversized.status).toBe(400);
    expect(services.listMissingSandboxIds).not.toHaveBeenCalled();
  });

  it("refuses non-runner tokens like every /v1/runner route", async () => {
    const res = await app.request("/v1/runner/sandboxes/check", {
      method: "POST",
      headers: { authorization: `Bearer ${ORG_KEY}` },
      body: JSON.stringify({ sandboxIds: ["sb-1"] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/runners (the human view)", () => {
  it("requires user auth, not a runner token", async () => {
    const res = await app.request("/v1/runners", {
      headers: { authorization: `Bearer ${RUNNER_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("lists runners for an authenticated caller without a workspace header", async () => {
    services.listRunners.mockResolvedValue([
      {
        id: "r-1",
        name: "laptop",
        online: true,
        lastSeenAt: new Date("2026-08-04T10:00:00.000Z"),
        sandboxCount: 2,
        capabilities: CAPABILITIES,
      },
    ]);
    const res = await app.request("/v1/runners", {
      headers: { authorization: `Bearer ${ORG_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runners: Array<{ id: string }> };
    expect(body.runners).toHaveLength(1);
    expect(body.runners[0]?.id).toBe("r-1");
  });
});

describe("GET /v1/instance", () => {
  it("carries the runner availability bit (§3.13)", async () => {
    services.getRunnerAvailability.mockResolvedValue({
      registered: true,
      online: false,
    });
    const res = await app.request("/v1/instance");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runners: { registered: true, online: false },
    });
  });

  it("reports nothing registered on a deployment that never had a runner", async () => {
    const res = await app.request("/v1/instance");
    expect(await res.json()).toMatchObject({
      runners: { registered: false, online: false },
    });
  });
});
