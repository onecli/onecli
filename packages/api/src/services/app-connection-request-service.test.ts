import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `request_app_connection`'s decisions, mocked at the DB and grant seams:
 * which app a name means, which of the four answers applies, and that every
 * read is fenced to the CALLING agent's workspace and organization. The links
 * must be byte-compatible with the gateway's, because the chat card parses
 * them (`apps/web/src/lib/chat/connect-links.ts`).
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.APP_URL = "https://app.example.com";
});

const state = vi.hoisted(() => ({
  agent: { name: "Donna & Co" } as { name: string } | null,
  existing: null as { id: string } | null,
}));

const dbMock = vi.hoisted(() => ({
  agent: { findFirst: vi.fn(async () => state.agent) },
  appConnection: { findFirst: vi.fn(async () => state.existing) },
}));

const render = vi.hoisted(() => ({ connectionsForRender: vi.fn() }));

vi.mock("@onecli/db", () => ({ db: dbMock }));
vi.mock("./agent-connections-render", () => render);

const { requestAppConnection, resolveCatalogApp } =
  await import("./app-connection-request-service");

const ME = { agentId: "ag-1", workspaceId: "ws-1", organizationId: "org-1" };

beforeEach(() => {
  vi.clearAllMocks();
  state.agent = { name: "Donna & Co" };
  state.existing = null;
  render.connectionsForRender.mockResolvedValue([]);
});

describe("resolveCatalogApp", () => {
  it("matches an id or a display name, ignoring case and punctuation", () => {
    expect(resolveCatalogApp("jira")?.id).toBe("jira");
    expect(resolveCatalogApp("Confluence")?.id).toBe("confluence");
    expect(resolveCatalogApp("Google Calendar")?.id).toBe("google-calendar");
    expect(resolveCatalogApp("google-calendar")?.id).toBe("google-calendar");
  });

  it("never guesses: a near miss is no app", () => {
    expect(resolveCatalogApp("atlassian")).toBeUndefined();
    expect(resolveCatalogApp("   ")).toBeUndefined();
  });
});

describe("requestAppConnection", () => {
  it("nothing connected: the gateway's app_not_connected link, naming the agent", async () => {
    const res = await requestAppConnection(ME, "Jira");
    expect(res).toMatchObject({ status: "connect", app: "jira", name: "Jira" });
    expect(res.status === "connect" && res.connectUrl).toBe(
      "https://app.example.com/w/ws-1/connections?connect=jira&source=agent&agent_name=Donna%20%26%20Co&agent_id=ag%2D1",
    );
    expect(res.note).toMatch(/Do not offer an API key/);
  });

  it("encodes the agent like the gateway (NON_ALPHANUMERIC), so the card reads the whole name", async () => {
    state.agent = { name: "Bob's Bot (EU)_v1.0!~*" };
    const res = await requestAppConnection(ME, "jira");
    if (res.status !== "connect") throw new Error("expected connect");
    expect(res.connectUrl).toContain(
      "&agent_name=Bob%27s%20Bot%20%28EU%29%5Fv1%2E0%21%7E%2A&agent_id=ag%2D1",
    );
    expect(new URL(res.connectUrl).searchParams.get("agent_name")).toBe(
      "Bob's Bot (EU)_v1.0!~*",
    );
  });

  it("the agent is read only inside its own workspace", async () => {
    await requestAppConnection(ME, "jira");
    expect(dbMock.agent.findFirst).toHaveBeenCalledWith({
      where: { id: "ag-1", workspaceId: "ws-1" },
      select: { name: true },
    });
  });

  it("an account exists but is off for this agent: the attach link leads", async () => {
    state.existing = { id: "conn-1" };
    const res = await requestAppConnection(ME, "confluence");
    expect(res).toMatchObject({ status: "attach", app: "confluence" });
    if (res.status !== "attach") throw new Error("expected attach");
    expect(res.manageUrl).toBe(
      "https://app.example.com/w/ws-1/agents/ag-1/connections?attach=confluence",
    );
    expect(res.connectUrl).toContain("/connections?connect=confluence");
  });

  it("the account probe is fenced to this workspace and this org's shared pool, skipping accounts waiting on a reconnect", async () => {
    await requestAppConnection(ME, "jira");
    expect(dbMock.appConnection.findFirst).toHaveBeenCalledWith({
      where: {
        provider: "jira",
        status: "connected",
        reauthRequiredAt: null,
        OR: [
          { workspaceId: "ws-1" },
          { organizationId: "org-1", scope: "organization" },
        ],
      },
      select: { id: true },
    });
  });

  it("already granted: use it, no link minted", async () => {
    render.connectionsForRender.mockResolvedValue([
      { provider: "jira", name: "Jira", label: null, host: null },
    ]);
    const res = await requestAppConnection(ME, "jira");
    expect(res.status).toBe("connected");
    expect(render.connectionsForRender).toHaveBeenCalledWith("ag-1");
    expect(JSON.stringify(res)).not.toContain("/connections");
    expect(dbMock.appConnection.findFirst).not.toHaveBeenCalled();
  });

  it("no built-in app: suggests near names, and only then a custom connection", async () => {
    const res = await requestAppConnection(ME, "atlassian");
    expect(res.status).toBe("no_builtin_app");
    if (res.status !== "no_builtin_app") throw new Error("expected none");
    expect(res.similar.map((s) => s.app)).toEqual(
      expect.arrayContaining(["jira", "confluence"]),
    );
    const none = await requestAppConnection(ME, "AcmeCRM");
    expect(none).toMatchObject({ status: "no_builtin_app", similar: [] });
    expect(none.note).toContain("propose_custom_connection");
    expect(dbMock.appConnection.findFirst).not.toHaveBeenCalled();
  });

  it("a query naming an app suggests it; a short app name counts only as a whole word", async () => {
    const named = await requestAppConnection(ME, "salesforce cpq");
    if (named.status !== "no_builtin_app") throw new Error("expected none");
    expect(named.similar.map((s) => s.app)).toContain("salesforce");

    // "x" sits inside "mixpanel" and "xero", and "aws" inside "laws": none
    // of them is X or AWS.
    for (const query of ["mixpanel", "xero", "laws"]) {
      const res = await requestAppConnection(ME, query);
      if (res.status !== "no_builtin_app") throw new Error("expected none");
      expect(res.similar.map((s) => s.app)).not.toContain("x");
      expect(res.similar.map((s) => s.app)).not.toContain("aws");
    }
    const word = await requestAppConnection(ME, "aws billing");
    if (word.status !== "no_builtin_app") throw new Error("expected none");
    expect(word.similar.map((s) => s.app)).toContain("aws");
  });
});
