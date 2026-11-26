import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The supersede contract: a person's mid-run message withdraws THIS agent's
 * held request(s) only on a clear REPLACE from the fast model, and every
 * other path (no person, another live conversation, nothing held, no key,
 * KEEP, a refused or thrown call) keeps the card. Nothing is ever approved.
 * The DB, the gateway client and the fast model are mocked at their module
 * seams; the gateway's own `superseded` handling is proven in its Rust
 * suites, the transcript notice in conversation-notice.
 */

const m = vi.hoisted(() => ({
  conversation: vi.fn<() => Promise<unknown>>(),
  liveTurns: vi.fn<() => Promise<{ conversationId: string }[]>>(),
  user: vi.fn<() => Promise<unknown>>(async () => ({ email: "p@x.dev" })),
  cards: vi.fn<(arg: unknown) => Promise<unknown[]>>(async () => []),
  cardUpdate: vi.fn<(arg: unknown) => Promise<void>>(async () => {}),
  ensureKey: vi.fn(async () => "oc_person"),
  list: vi.fn<() => Promise<unknown[]>>(),
  decide: vi.fn<(arg: unknown) => Promise<{ outcome: string }>>(async () => ({
    outcome: "decided",
  })),
  llmKey: vi.fn<() => Promise<unknown>>(async () => ({
    ok: true,
    key: { provider: "anthropic", authMode: "api-key", value: "sk-ant-test" },
  })),
  ask: vi.fn<(key: unknown, arg: { prompt: string }) => Promise<string>>(),
  audit: vi.fn(async () => {}),
  notice: vi.fn(async () => true),
  settle: vi.fn(async () => {}),
  /** The gateway's pending log row for this agent (null: nothing held). */
  pendingRow: vi.fn<() => Promise<unknown>>(async () => ({ id: "log-1" })),
}));

vi.mock("@onecli/db", () => ({
  db: {
    conversation: { findFirst: m.conversation },
    turn: { findMany: m.liveTurns },
    user: { findUnique: m.user },
    toolApprovalCard: { findMany: m.cards, updateMany: m.cardUpdate },
    requestLog: { findFirst: m.pendingRow },
  },
}));
vi.mock("../providers", () => ({
  getCrypto: () => ({ decrypt: async (v: string) => `plain:${v}` }),
}));
vi.mock("./api-key-service", () => ({ ensureWorkspaceApiKey: m.ensureKey }));
vi.mock("./channels/gateway-approvals", () => ({
  listPendingApprovalsAtGateway: m.list,
  decideApprovalAtGateway: m.decide,
}));
vi.mock("./llm-direct-call", () => ({ resolveLlmCallKey: m.llmKey }));
vi.mock("./judges/fast-model", () => ({ askFastModel: m.ask }));
vi.mock("./audit-service", async (orig) => ({
  ...(await orig<typeof import("./audit-service")>()),
  recordAuditEvent: m.audit,
}));
vi.mock("./conversation-notice", () => ({
  writeConversationNotice: m.notice,
}));
vi.mock("./channels/registry", () => ({
  channelProvider: () => ({ settleGatewayApprovalCard: m.settle }),
}));

const svc = await import("./approval-supersede-service");

const AGENT = {
  id: "ag-1",
  name: "Ada",
  workspaceId: "ws-1",
  workspace: { organizationId: "org-1" },
};

const held = (id: string, agentId = "ag-1") => ({
  id,
  agent: { id: agentId },
  summary: {
    action: "Create 5 Accounts",
    details: [],
    bulk: {
      objectLabel: "Account",
      fields: [{ label: "Billing city" }, { label: "Name" }],
      rows: [
        { name: "Acme", new: ["Boston", "Acme"] },
        { name: "Globex", new: ["Boston", "Globex"] },
        { name: "Initech", new: ["New York", "Initech"] },
        { name: "Umbrella", new: [null, "Umbrella"] },
        { name: "Hooli", new: ["", "Hooli"] },
      ],
    },
  },
});

const INPUT = {
  workspaceId: "ws-1",
  conversationId: "c-1",
  targetTurnId: "t-1",
  message: "can you change all Billing city to be NYC?",
  origin: { source: "web" as const, userId: "u-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.conversation.mockResolvedValue({ agent: AGENT });
  m.liveTurns.mockResolvedValue([{ conversationId: "c-1" }]);
  m.list.mockResolvedValue([held("ap-1"), held("ap-other", "ag-2")]);
  m.pendingRow.mockResolvedValue({ id: "log-1" });
  m.ask.mockResolvedValue("The message asks for NYC; they are Boston.\nCHANGE");
});

describe("supersedeHeldApprovals", () => {
  it("withdraws THIS agent's held request on REPLACE, as superseded, under the person's key", async () => {
    // The ledger row, then the rows sharing its message (just itself).
    m.cards
      .mockResolvedValueOnce([
        {
          id: "card-1",
          approvalId: "ap-1",
          state: "pending",
          agentChannelId: "pres-1",
          externalMessageRef: "D1:1700.1",
          agentChannel: { provider: "slack", credentials: "enc" },
        },
      ])
      .mockResolvedValueOnce([
        {
          approvalId: "ap-1",
          agentChannelId: "pres-1",
          externalMessageRef: "D1:1700.1",
        },
      ]);

    expect(await svc.supersedeHeldApprovals(INPUT)).toEqual(["ap-1"]);

    // Only this agent's approval; never another agent's.
    expect(m.decide).toHaveBeenCalledTimes(1);
    expect(m.decide).toHaveBeenCalledWith({
      serviceKey: "oc_person",
      approvalId: "ap-1",
      decision: "deny",
      reason: "superseded",
    });
    // The model saw the held request and the person's message.
    const prompt = m.ask.mock.calls[0]![1].prompt;
    expect(prompt).toContain("Create 5 Accounts");
    // The judge sees each record's VALUES, so agreement is not a change,
    // and what each record does NOT set, so adding a field is one.
    expect(prompt).toContain(
      "5 Account records, each with exactly what it sets:",
    );
    expect(prompt).toContain("1. Acme: sets Billing city=Boston; Name=Acme");
    expect(prompt).toContain("3. Initech: sets Billing city=New York");
    expect(prompt).toContain(
      "4. Umbrella: sets Name=Umbrella | does NOT set: Billing city",
    );
    expect(prompt).toContain("5. Hooli: sets Name=Hooli");
    expect(prompt).toContain("Billing city to be NYC");
    // Audited under the person, the notice names the id, the card settles.
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-1",
        action: "deny",
        metadata: expect.objectContaining({
          approvalId: "ap-1",
          reason: "superseded",
        }),
      }),
    );
    expect(m.notice).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "c-1",
        turnId: "t-1",
        extra: { supersededApprovalIds: ["ap-1"] },
      }),
    );
    expect(m.cardUpdate).toHaveBeenCalledWith({
      where: { id: { in: ["card-1"] } },
      data: { state: "decided" },
    });
    // One card for one request: its title, then the outcome.
    expect(m.settle).toHaveBeenCalledWith({
      credentialsJson: "plain:enc",
      externalMessageRef: "D1:1700.1",
      title: "Create 5 Accounts",
      text: svc.SUPERSEDED_CARD_TEXT,
    });
  });

  it("rewrites a grouped card once, and only when every request on it was replaced", async () => {
    m.list.mockResolvedValue([held("ap-1"), held("ap-2")]);
    const card = (approvalId: string) => ({
      id: `card-${approvalId}`,
      approvalId,
      state: "pending",
      agentChannelId: "pres-1",
      externalMessageRef: "D1:1700.1",
      agentChannel: { provider: "slack", credentials: "enc" },
    });
    const sharing = (approvalIds: string[]) =>
      approvalIds.map((approvalId) => ({
        approvalId,
        agentChannelId: "pres-1",
        externalMessageRef: "D1:1700.1",
      }));
    // Both requests share the message: one rewrite, no single title.
    m.cards
      .mockResolvedValueOnce([card("ap-1"), card("ap-2")])
      .mockResolvedValueOnce(sharing(["ap-1", "ap-2"]));
    expect(await svc.supersedeHeldApprovals(INPUT)).toEqual(["ap-1", "ap-2"]);
    expect(m.settle).toHaveBeenCalledTimes(1);
    expect(m.settle).toHaveBeenCalledWith(
      expect.objectContaining({ title: undefined }),
    );

    // A third request on the same card is still waiting: leave the card to
    // the adapter, which re-renders it row by row.
    m.settle.mockClear();
    m.cards
      .mockResolvedValueOnce([card("ap-1"), card("ap-2")])
      .mockResolvedValueOnce(sharing(["ap-1", "ap-2", "ap-3"]));
    await svc.supersedeHeldApprovals(INPUT);
    expect(m.settle).not.toHaveBeenCalled();
  });

  it.each([
    ["CANCEL"],
    ["They asked to stop it.\nCANCEL"],
    ["Different city.\n**CHANGE**"],
  ])("answer %j withdraws it", async (answer) => {
    m.ask.mockResolvedValue(answer);
    expect(await svc.supersedeHeldApprovals(INPUT)).toEqual(["ap-1"]);
  });

  it.each([
    ["ALREADY"],
    ["3 records are already Boston.\nALREADY"],
    ["OTHER"],
    ["keep."],
    [""],
    // The verdict is the LAST line only: the word in the comparison line
    // never decides ("... no CHANGE needed" must not withdraw).
    ["No CHANGE needed, values match.\nALREADY"],
    ["CHANGE\nALREADY"],
    ["I think CHANGE"],
  ])("answer %j keeps the card", async (answer) => {
    m.ask.mockResolvedValue(answer);
    expect(await svc.supersedeHeldApprovals(INPUT)).toEqual([]);
    expect(m.decide).not.toHaveBeenCalled();
    expect(m.notice).not.toHaveBeenCalled();
  });

  it("keeps the card when the model call fails or times out", async () => {
    m.ask.mockRejectedValue(new Error("aborted"));
    expect(await svc.supersedeHeldApprovals(INPUT)).toEqual([]);
    expect(m.decide).not.toHaveBeenCalled();
  });

  it("only a person speaks for a held request: no user, no check", async () => {
    expect(
      await svc.supersedeHeldApprovals({
        ...INPUT,
        origin: { source: "webhook", userId: null },
      }),
    ).toEqual([]);
    expect(m.list).not.toHaveBeenCalled();
    expect(m.ask).not.toHaveBeenCalled();
  });

  it("keeps the card when the agent is live in another conversation too (ambiguous owner)", async () => {
    m.liveTurns.mockResolvedValue([
      { conversationId: "c-1" },
      { conversationId: "c-2" },
    ]);
    expect(await svc.supersedeHeldApprovals(INPUT)).toEqual([]);
    expect(m.list).not.toHaveBeenCalled();
  });

  it("keeps the card when the live exchange is a different conversation", async () => {
    m.liveTurns.mockResolvedValue([{ conversationId: "c-2" }]);
    expect(await svc.supersedeHeldApprovals(INPUT)).toEqual([]);
    expect(m.decide).not.toHaveBeenCalled();
  });

  it("asks nothing when this agent holds nothing", async () => {
    m.list.mockResolvedValue([held("ap-other", "ag-2")]);
    expect(await svc.supersedeHeldApprovals(INPUT)).toEqual([]);
    expect(m.ask).not.toHaveBeenCalled();
  });

  it("with nothing held, never mints a key or calls the gateway (every person message runs this)", async () => {
    m.pendingRow.mockResolvedValue(null);
    expect(await svc.supersedeHeldApprovals(INPUT)).toEqual([]);
    expect(m.ensureKey).not.toHaveBeenCalled();
    expect(m.list).not.toHaveBeenCalled();
    expect(m.ask).not.toHaveBeenCalled();
  });

  it("keeps the card without a usable LLM key", async () => {
    m.llmKey.mockResolvedValue({ ok: false, reason: "missing" });
    expect(await svc.supersedeHeldApprovals(INPUT)).toEqual([]);
    expect(m.decide).not.toHaveBeenCalled();
  });

  it("refuses a conversation outside the caller's workspace (the fence is in the query)", async () => {
    m.conversation.mockResolvedValue(null);
    expect(await svc.supersedeHeldApprovals(INPUT)).toEqual([]);
    expect(m.conversation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "c-1", agent: { workspaceId: "ws-1" } },
      }),
    );
  });

  it("records nothing when the gateway had already settled it", async () => {
    m.decide.mockResolvedValue({ outcome: "already_settled" });
    expect(await svc.supersedeHeldApprovals(INPUT)).toEqual([]);
    expect(m.notice).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("never throws: a failing gateway list keeps the card", async () => {
    m.list.mockRejectedValue(new Error("gateway down"));
    await expect(svc.supersedeHeldApprovals(INPUT)).resolves.toEqual([]);
  });

  it("acts with the speaker's own workspace key, read once with their email", async () => {
    await svc.supersedeHeldApprovals(INPUT);
    expect(m.ensureKey).toHaveBeenCalledWith({
      userId: "u-1",
      userEmail: "p@x.dev",
      workspaceId: "ws-1",
    });
    expect(m.user).toHaveBeenCalledTimes(1);
  });
});
