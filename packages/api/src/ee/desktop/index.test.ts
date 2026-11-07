import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The hosted desktop's implementation of the shared seam: what the ticket
// route mints, audits and refuses, and what the agent's tool validates and
// answers. The free routes that reach it are pinned in their own suites
// (routes/preview-auth.test.ts, services/platform-tool-service.test.ts);
// the poll claim and the service's rules are proven against PostgreSQL in
// service.pg.test.ts.

const state = vi.hoisted(() => ({
  host: null as Record<string, unknown> | null,
  minted: [] as Array<{ host: string; userId: string }>,
  audits: [] as Array<Record<string, unknown>>,
  takeover: vi.fn(),
}));

vi.mock("@onecli/db", () => ({ Prisma: {}, db: {} }));

vi.mock("../../lib/preview-availability", () => ({
  previewsEnabled: () => true,
}));

vi.mock("../../lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/env")>()),
  PREVIEW_DOMAIN: "preview.test",
}));

vi.mock("../../services/sandbox-port-service", () => ({
  authorizeHost: async () => state.host,
  mintPreviewTicket: (host: string, userId: string) => {
    state.minted.push({ host, userId });
    return "ticket-1";
  },
}));

vi.mock("../../services/audit-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/audit-service")>()),
  recordAuditEvent: async (event: Record<string, unknown>) => {
    state.audits.push(event);
  },
}));

vi.mock("./service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service")>()),
  requestTakeover: state.takeover,
}));

const { eeAgentDesktop } = await import("./index");

const VIEW = "d-agent-ab12.preview.test";
const desktopHost = (role: "view" | "control") => ({
  state: "ok",
  kind: "desktop",
  workspaceId: "ws-1",
  agentId: "agent-1",
  port: role === "view" ? 5900 : 5901,
  desktop: { role, controllerUserId: "user-1" },
});
const viewer = (host = VIEW) => ({
  userId: "user-1",
  userEmail: "person@example.com",
  host,
});

beforeEach(() => {
  state.host = null;
  state.minted = [];
  state.audits = [];
  state.takeover.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("mintTicket", () => {
  it("mints a host-bound ticket for the view, and audits the open", async () => {
    state.host = desktopHost("view");
    expect(await eeAgentDesktop.mintTicket(viewer())).toEqual({
      ticket: "ticket-1",
    });
    expect(state.minted).toEqual([{ host: VIEW, userId: "user-1" }]);
    expect(state.audits).toMatchObject([
      {
        workspaceId: "ws-1",
        userId: "user-1",
        action: "session_open",
        service: "desktop",
        metadata: { agentId: "agent-1", hostname: VIEW },
      },
    ]);
  });

  it("mints for the control host it admits without a second audit row (the lease is the audited event)", async () => {
    state.host = desktopHost("control");
    await eeAgentDesktop.mintTicket(viewer("d-agent-ab12-ctl.preview.test"));
    expect(state.minted).toHaveLength(1);
    expect(state.audits).toEqual([]);
  });

  it("refuses a host it does not admit, or a preview host, without minting", async () => {
    state.host = null;
    await expect(eeAgentDesktop.mintTicket(viewer())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    state.host = { state: "ok", kind: "preview", workspaceId: "ws-1" };
    await expect(
      eeAgentDesktop.mintTicket(viewer("p8080-agent-ab12.preview.test")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.minted).toEqual([]);
  });

  it("does not know a host outside the preview zone", async () => {
    state.host = desktopHost("view");
    await expect(
      eeAgentDesktop.mintTicket(viewer("d-agent-ab12.evil.test")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(state.minted).toEqual([]);
  });
});

describe("callTool (request_human_takeover)", () => {
  const call = (args: unknown) =>
    eeAgentDesktop.callTool({
      agentId: "ag-1",
      args,
      originConversationId: "conv-1",
      originTurnId: "t-1",
    });

  it("records the ask for the calling agent with the asking turn, and tells the model to stop", async () => {
    state.takeover.mockResolvedValue({
      status: "requested",
      url: "https://app.example.com/w/p1/agents/ag-1/computer?takeover=req-1",
    });
    const res = await call({ reason: "Sign in to the portal" });
    expect(state.takeover).toHaveBeenCalledWith({
      agentId: "ag-1",
      reason: "Sign in to the portal",
      originConversationId: "conv-1",
      originTurnId: "t-1",
    });
    expect(res).toMatchObject({
      ok: true,
      result: {
        status: "requested",
        url: "https://app.example.com/w/p1/agents/ag-1/computer?takeover=req-1",
      },
    });
    expect(JSON.stringify(res)).toContain("End your reply now");
  });

  it("omits the url when the operator configured no dashboard", async () => {
    state.takeover.mockResolvedValue({ status: "requested", url: null });
    const res = await call({ reason: "captcha" });
    expect(res).toMatchObject({ ok: true, result: { status: "requested" } });
    expect(JSON.stringify(res)).not.toContain('"url"');
  });

  it("refuses a missing, empty, or over-long reason before touching the service", async () => {
    for (const args of [{}, { reason: "" }, { reason: "x".repeat(301) }]) {
      expect((await call(args)).ok).toBe(false);
    }
    expect(state.takeover).not.toHaveBeenCalled();
  });
});
