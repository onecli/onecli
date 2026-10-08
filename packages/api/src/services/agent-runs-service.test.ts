import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  turn: vi.fn(),
  events: vi.fn(),
  logs: vi.fn(),
  role: vi.fn(),
  turns: vi.fn(),
  rbac: true,
}));
vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    agent: { findFirst: mocks.agent },
    turn: { findFirst: mocks.turn, findMany: mocks.turns },
    turnEvent: { findMany: mocks.events },
    requestLog: { findMany: mocks.logs },
  },
}));
vi.mock("../lib/env", () => ({
  CAPS: {
    get rbac() {
      return mocks.rbac;
    },
  },
}));
vi.mock("../providers", () => ({
  getRoleResolver: () => ({ getUserRole: mocks.role }),
}));
const { getEvalRunEvidence, getRun, listRuns } =
  await import("./agent-runs-service");
const turn = {
  id: "turn",
  conversationId: "conv",
  source: "eval",
  status: "done",
  message: "question",
  error: null,
  createdAt: new Date("2026-09-01T12:00:00Z"),
  startedAt: new Date("2026-09-01T12:00:00Z"),
  finishedAt: new Date("2026-09-01T12:01:00Z"),
  conversation: { direct: false, userId: null },
  user: { id: "viewer", email: "viewer@example.com", name: null },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.agent.mockResolvedValue({ id: "agent" });
  mocks.turn.mockResolvedValueOnce(turn).mockResolvedValue(null);
  mocks.turns.mockResolvedValue([turn]);
  mocks.rbac = true;
  mocks.role.mockResolvedValue("member");
  mocks.events.mockResolvedValue([
    { turnId: "turn", payload: { type: "text", text: "answer" } },
  ]);
  mocks.logs.mockResolvedValue([]);
});
describe("Runs evidence query boundaries", () => {
  it("keeps provider evidence and adds only requested matched custom host tokens", async () => {
    mocks.logs.mockResolvedValue([
      { provider: "github", host: "API.GitHub.com:443" },
      { provider: "unknown", host: "internal.example.com" },
      { provider: "unknown", host: "private.unrequested.example.com" },
    ]);
    const run = await getEvalRunEvidence(
      "ws",
      "org",
      "viewer",
      "agent",
      "turn",
      [
        "github",
        "host:api.github.com",
        "host:INTERNAL.example.com",
        "host:wrong.example.com",
        "host:api.github.com",
      ],
    );
    expect(run).toEqual({
      answer: "answer",
      appsUsed: [
        "github",
        "unknown",
        "host:api.github.com",
        "host:INTERNAL.example.com",
      ],
      appAttribution: "agent_time_window",
    });
    expect(mocks.logs).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws",
        agentId: "agent",
        createdAt: {
          gte: new Date("2026-09-01T11:59:58Z"),
          lte: new Date("2026-09-01T12:01:02Z"),
        },
      },
      select: { provider: true, host: true },
      take: 5001,
    });
  });

  it("preserves provider-only evidence for callers not requesting hosts", async () => {
    mocks.logs.mockResolvedValue([
      { provider: "github", host: "api.github.com" },
    ]);
    const run = await getEvalRunEvidence(
      "ws",
      "org",
      "viewer",
      "agent",
      "turn",
      [],
    );
    expect(run.appsUsed).toEqual(["github"]);
  });

  it.each([
    "",
    "*.example.com",
    "api.*.com",
    "https://api.example.com",
    "api.example.com/path",
    "api.example.com?x=1",
    "api.example.com#x",
    "user@api.example.com",
    "api.example.com:443",
    "api.example.com:8443",
    " api.example.com",
    "api.example.com ",
    "api.example.com\n",
    "api..example.com",
    ".api.example.com",
    "api.example.com.",
    "-api.example.com",
    "api-.example.com",
    "api_foo.example.com",
    "äpp.example.com",
    `${"a".repeat(64)}.example.com`,
    "a.".repeat(127) + "a",
  ])(
    "never matches malformed host token host:%s even against the same raw log",
    async (host) => {
      mocks.logs.mockResolvedValue([{ provider: "unknown", host }]);
      const run = await getEvalRunEvidence(
        "ws",
        "org",
        "viewer",
        "agent",
        "turn",
        [`host:${host}`],
      );
      expect(run.appsUsed).toEqual(["unknown"]);
    },
  );

  it.each([
    "api.example.com:8443",
    "api.example.com:0443",
    "api.example.com.evil.test",
    "sub.api.example.com",
    "https://api.example.com",
    "api.example.com/path",
  ])(
    "does not alias request host %s to the requested hostname",
    async (host) => {
      mocks.logs.mockResolvedValue([{ provider: "unknown", host }]);
      const run = await getEvalRunEvidence(
        "ws",
        "org",
        "viewer",
        "agent",
        "turn",
        ["host:api.example.com"],
      );
      expect(run.appsUsed).toEqual(["unknown"]);
    },
  );

  it("never matches requested LLM hosts or LLM-provider logs", async () => {
    mocks.logs.mockResolvedValue([
      { provider: "unknown", host: "API.OpenAI.com:443" },
      { provider: "anthropic", host: "custom.example.com" },
    ]);
    const run = await getEvalRunEvidence(
      "ws",
      "org",
      "viewer",
      "agent",
      "turn",
      ["host:api.openai.com", "host:custom.example.com"],
    );
    expect(run.appsUsed).toEqual([]);
  });

  it("requires the scoped owned eval turn before querying any evidence", async () => {
    mocks.turn.mockReset().mockResolvedValue(null);
    await expect(
      getEvalRunEvidence(
        "ws",
        "org",
        "viewer",
        "agent",
        "foreign-or-non-eval",
        ["host:api.example.com"],
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.agent).toHaveBeenCalledWith({
      where: {
        id: "agent",
        workspaceId: "ws",
        workspace: { organizationId: "org" },
      },
      select: { id: true },
    });
    expect(mocks.turn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "foreign-or-non-eval",
          source: "eval",
          userId: "viewer",
          conversation: {
            agentId: "agent",
            agent: { workspaceId: "ws" },
            source: "eval",
            direct: false,
          },
        },
      }),
    );
    expect(mocks.logs).not.toHaveBeenCalled();
    expect(mocks.events).not.toHaveBeenCalled();
  });

  it.each(["startedAt", "finishedAt"])(
    "withholds requested host evidence without %s",
    async (field) => {
      mocks.turn
        .mockReset()
        .mockResolvedValueOnce({ ...turn, [field]: null })
        .mockResolvedValue(null);
      const run = await getEvalRunEvidence(
        "ws",
        "org",
        "viewer",
        "agent",
        "turn",
        ["host:api.example.com"],
      );
      expect(run).toEqual({
        answer: "answer",
        appsUsed: [],
        appAttribution: "withheld",
      });
      expect(mocks.logs).not.toHaveBeenCalled();
    },
  );

  it("withholds over-cap public evidence in list, detail and app-filtered scans", async () => {
    mocks.role.mockResolvedValue("admin");
    mocks.logs.mockResolvedValue(
      Array.from({ length: 5001 }, () => ({ provider: "notion" })),
    );
    const list = await listRuns("ws", "org", "viewer", "agent");
    expect(list.appEvidenceWithheld).toBe(true);
    expect(list.runs[0]).toMatchObject({
      appsUsed: [],
      appAttribution: "withheld",
    });
    const { run } = await getRun("ws", "org", "viewer", "agent", "turn");
    expect(run).toMatchObject({
      appsUsed: [],
      appCalls: [],
      appAttribution: "withheld",
    });
    mocks.turns.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({ ...turn, id: `turn-${i}` })),
    );
    const filtered = await listRuns("ws", "org", "viewer", "agent", {
      app: "notion",
    });
    expect(filtered.runs).toEqual([]);
    expect(filtered.appEvidenceWithheld).toBe(true);
    expect(filtered.nextBefore).toBe(`${turn.createdAt.toISOString()}~turn-99`);
  });

  it.each([
    "not-a-date",
    "2026-09-01T12:00:00Z~",
    "2026-09-01T12:00:00Z~id~extra",
  ])("rejects malformed cursor %s", async (before) => {
    await expect(
      listRuns("ws", "org", "viewer", "agent", { before }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    expect(mocks.turns).not.toHaveBeenCalled();
  });
  it("does not query gateway logs at all for a restricted viewer's list or detail", async () => {
    await listRuns("ws", "org", "viewer", "agent");
    const { run } = await getRun("ws", "org", "viewer", "agent", "turn");
    expect(run.appAttribution).toBe("withheld");
    expect(mocks.logs).not.toHaveBeenCalled();
    expect(mocks.role).toHaveBeenCalledWith("viewer", "org");
  });

  it("grants no admin override without role enforcement, whatever the stored role", async () => {
    mocks.rbac = false;
    mocks.role.mockResolvedValue("owner");
    const list = await listRuns("ws", "org", "viewer", "agent");
    expect(list.isAdmin).toBe(false);
    expect(mocks.role).not.toHaveBeenCalled();
    expect(mocks.logs).not.toHaveBeenCalled();
    expect(mocks.turns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conversation: expect.objectContaining({
            AND: expect.arrayContaining([
              { OR: [{ direct: false }, { userId: "viewer" }] },
            ]),
          }),
        }),
      }),
    );
  });

  it("parses event payloads with the protocol schemas and skips unknown shapes", async () => {
    mocks.role.mockResolvedValue("admin");
    mocks.events.mockResolvedValue([
      {
        turnId: "turn",
        payload: { type: "tool.started", callId: "c1", name: "bash" },
      },
      {
        turnId: "turn",
        payload: {
          type: "tool.finished",
          callId: "c1",
          name: "bash",
          input: '{"command":"ls"}',
          output: "a",
          isError: true,
        },
      },
      {
        turnId: "turn",
        payload: {
          type: "tool.finished",
          callId: "c2",
          name: "read",
          output: "b",
        },
      },
      { turnId: "turn", payload: { type: "tool.finished", callId: 7 } },
      { turnId: "turn", payload: { type: "text", text: "done" } },
    ]);
    const { run } = await getRun("ws", "org", "viewer", "agent", "turn");
    expect(run.answer).toBe("done");
    expect(run.tools).toEqual([
      {
        callId: "c1",
        name: "bash",
        input: '{"command":"ls"}',
        output: "a",
        isError: true,
      },
      { callId: "c2", name: "read", input: null, output: "b", isError: false },
    ]);
    expect(run.toolNames).toEqual(["bash", "read"]);
  });
  it("withholds truncated single-turn eval evidence instead of returning a partial app set", async () => {
    mocks.logs.mockResolvedValue(
      Array.from({ length: 5001 }, () => ({
        provider: "custom",
        host: "data.example.com",
      })),
    );
    const run = await getEvalRunEvidence(
      "ws",
      "org",
      "viewer",
      "agent",
      "turn",
      ["host:data.example.com"],
    );
    expect(run).toEqual({
      answer: "answer",
      appsUsed: [],
      appAttribution: "withheld",
    });
    expect(mocks.logs).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 5001,
        select: { provider: true, host: true },
      }),
    );
  });
  it("does not query gateway logs for overlapping eval evidence", async () => {
    mocks.turn
      .mockReset()
      .mockResolvedValueOnce(turn)
      .mockResolvedValueOnce({ id: "private-turn" });
    const run = await getEvalRunEvidence(
      "ws",
      "org",
      "viewer",
      "agent",
      "turn",
      ["host:api.example.com"],
    );
    expect(run.appAttribution).toBe("withheld");
    expect(run.appsUsed).toEqual([]);
    expect(mocks.logs).not.toHaveBeenCalled();
  });
});
