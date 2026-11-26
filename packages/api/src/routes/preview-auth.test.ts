import { afterEach, describe, expect, it, vi } from "vitest";

// POST /v1/preview-auth is the login handoff (plans/sandbox-ports.md §6):
// the dashboard's /preview-auth page calls it with the viewer's normal
// credentials and NO tenant header, because that page lives outside every
// `/w/<id>` and `/org/<id>` URL. The route must therefore answer the
// PERSON, not a tenant:
//
//   - a session with no X-Workspace-Id / X-Organization-Id must mint (the
//     cloud's `auth()` resolves a session only through a tenant header, so
//     it 401'd every handoff on the first dev roll);
//   - an API key, even a valid one, is refused: a key acts for a workspace
//     or an org and must never mint a browser session for a preview;
//   - the viewer is fenced by authorizePreview against the preview's OWN
//     workspace (a non-member gets 403, never a ticket);
//   - the edition's session enforcer still applies.

const state = vi.hoisted(() => ({
  session: null as { id: string; email: string } | null,
  authorized: null as {
    workspaceId: string;
    agentId: string;
    port: number;
  } | null,
  /** What `resolveHost` answers for the relay's activity beat. */
  host: null as Record<string, unknown> | null,
  minted: [] as Array<{ host: string; userId: string }>,
  audits: [] as Array<Record<string, unknown>>,
  activity: [] as Array<{
    agentId: string;
    userId: string | null;
    role: "view" | "control";
  }>,
  tickets: [] as Array<{ userId: string; userEmail: string; host: string }>,
  previewActivity: [] as string[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  db: {
    apiKey: {
      findUnique: async () => ({
        userId: "user-1",
        organizationId: "org-1",
        scope: "organization",
      }),
      findFirst: async () => null,
    },
    user: {
      findUnique: async ({
        where,
      }: {
        where: { externalAuthId?: string; id?: string };
      }) =>
        where.externalAuthId === "ext-1" || where.id === "user-1"
          ? { id: "user-1", email: "person@example.com" }
          : null,
    },
    organizationMember: { findFirst: async () => null },
    organizationDomain: { findFirst: async () => null },
  },
}));

vi.mock("../lib/preview-availability", () => ({
  previewsEnabled: () => true,
  previewAvailability: () => ({ enabled: true, domain: "preview.test" }),
}));

vi.mock("../lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/env")>()),
  PREVIEW_DOMAIN: "preview.test",
  PREVIEW_RELAY_SECRET: "r".repeat(32),
}));

vi.mock("../services/sandbox-port-service", () => ({
  authorizePreview: async () => state.authorized,
  mintPreviewTicket: (host: string, userId: string) => {
    state.minted.push({ host, userId });
    return "ticket-1";
  },
  listSandboxPorts: async () => [],
  markPreviewActivity: async (agentId: string) => {
    state.previewActivity.push(agentId);
  },
  resolveHost: async () => state.host,
  shareSandboxPort: async () => null,
  unshareSandboxPort: async () => undefined,
  userCanViewHost: async () => false,
  verifyPreviewTicket: () => null,
}));

vi.mock("../services/audit-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/audit-service")>()),
  recordAuditEvent: async (event: Record<string, unknown>) => {
    state.audits.push(event);
  },
}));

const { createApiApp } = await import("../app");
const { IS_CLOUD } = await import("../lib/env");
const { initSessionEnforcer } = await import("../providers");
const { initAgentDesktop } = await import("../providers/hooks/agent-desktop");

/** A hosted-platform desktop stand-in: records what the free routes hand it. */
const stubDesktop = () =>
  initAgentDesktop({
    sweep: async () => undefined,
    claimPushes: async () => [],
    markActivity: async (agentId, userId, role) => {
      state.activity.push({ agentId, userId, role });
    },
    mintTicket: async (viewer) => {
      state.tickets.push(viewer);
      return { ticket: "desktop-ticket-1" };
    },
    callTool: async () => ({ ok: false, error: "unused" }),
  });

const app = createApiApp(
  { getSession: async () => state.session },
  { roleResolver: { getUserRole: async () => "owner" } },
);

const HOST = "p8080-agent-ab12.preview.test";
const handoff = (headers: Record<string, string> = {}) =>
  app.request("/v1/preview-auth", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ host: HOST, path: "/admin" }),
  });

afterEach(() => {
  state.session = null;
  state.authorized = null;
  state.host = null;
  state.minted = [];
  state.audits = [];
  state.activity = [];
  state.tickets = [];
  state.previewActivity = [];
  initSessionEnforcer(null);
  initAgentDesktop(null);
});

describe("POST /v1/preview-auth", () => {
  it("mints a host-bound ticket for a signed-in person with NO tenant header", async () => {
    state.session = { id: "ext-1", email: "person@example.com" };
    state.authorized = { workspaceId: "ws-1", agentId: "agent-1", port: 8080 };
    const res = await handoff();
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const dest = new URL(url);
    expect(dest.hostname).toBe(HOST);
    expect(dest.pathname).toBe("/__onecli/auth");
    expect(dest.searchParams.get("ticket")).toBe("ticket-1");
    expect(dest.searchParams.get("path")).toBe("/admin");
    expect(state.minted).toEqual([{ host: HOST, userId: "user-1" }]);
    // An access event, attributed to the person and the preview's workspace.
    expect(state.audits).toMatchObject([
      {
        workspaceId: "ws-1",
        userId: "user-1",
        metadata: { agentId: "agent-1", port: "8080", hostname: HOST },
      },
    ]);
  });

  it("refuses a valid API key: a key must never mint a browser session", async () => {
    const res = await handoff({ Authorization: "Bearer oc_org_test-key" });
    expect(res.status).toBe(401);
    expect(state.minted).toEqual([]);
  });

  it("401s with no session", async () => {
    const res = await handoff();
    expect(res.status).toBe(401);
    expect(state.minted).toEqual([]);
  });

  it("403s a person who is not a member of the preview's workspace, without minting", async () => {
    state.session = { id: "ext-1", email: "person@example.com" };
    state.authorized = null;
    const res = await handoff();
    expect(res.status).toBe(403);
    expect(state.minted).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("404s a host outside the preview domain", async () => {
    state.session = { id: "ext-1", email: "person@example.com" };
    state.authorized = { workspaceId: "ws-1", agentId: "agent-1", port: 8080 };
    const res = await app.request("/v1/preview-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "p8080-agent-ab12.evil.test", path: "/" }),
    });
    expect(res.status).toBe(404);
    expect(state.minted).toEqual([]);
  });

  it("honors the edition's session enforcer", async () => {
    state.session = { id: "ext-1", email: "person@example.com" };
    state.authorized = { workspaceId: "ws-1", agentId: "agent-1", port: 8080 };
    initSessionEnforcer(async () => ({
      error: "SSO required",
      code: "sso_required",
    }));
    const res = await handoff();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "sso_required", message: "SSO required" },
    });
    expect(state.minted).toEqual([]);
  });
});

// POST /v1/preview-auth/desktop-ticket: a hosted-platform stream credential.
// The free route only authenticates the PERSON (same door as the handoff)
// and hands the host to the implementation; what it mints, audits and
// refuses is pinned beside it (ee/desktop/index.test.ts). Without one
// (every self-host) the route is not found.
describe("POST /v1/preview-auth/desktop-ticket", () => {
  const VIEW = "d-agent-ab12.preview.test";
  const ticket = (host = VIEW, headers: Record<string, string> = {}) =>
    app.request("/v1/preview-auth/desktop-ticket", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ host }),
    });

  it("hands the signed-in person and the host to the implementation", async () => {
    stubDesktop();
    state.session = { id: "ext-1", email: "person@example.com" };
    const res = await ticket();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: "desktop-ticket-1" });
    expect(state.tickets).toEqual([
      { userId: "user-1", userEmail: "person@example.com", host: VIEW },
    ]);
  });

  // A self-host only exists in the onprem lane: cloud always boots the
  // hosted desktop, and `init(null)` resets to that default.
  it.skipIf(IS_CLOUD)(
    "is not found on a deployment without the hosted desktop (every self-host)",
    async () => {
      state.session = { id: "ext-1", email: "person@example.com" };
      const res = await ticket();
      expect(res.status).toBe(404);
      expect(state.tickets).toEqual([]);
      expect(state.minted).toEqual([]);
    },
  );

  it("401s with no session and refuses an API key, before the implementation", async () => {
    stubDesktop();
    expect((await ticket()).status).toBe(401);
    expect(
      (await ticket(VIEW, { Authorization: "Bearer oc_org_test-key" })).status,
    ).toBe(401);
    expect(state.tickets).toEqual([]);
  });
});

// POST /v1/preview-relay/activity: a non-preview host's beat names its
// viewer and goes to the hosted-platform implementation; a preview's beat
// stays as it was.
describe("POST /v1/preview-relay/activity", () => {
  const beat = (body: Record<string, unknown>) =>
    app.request("/v1/preview-relay/activity", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-preview-relay-secret": "r".repeat(32),
      },
      body: JSON.stringify(body),
    });

  it("a desktop host's beat goes to the implementation with the viewer", async () => {
    stubDesktop();
    state.host = {
      state: "ok",
      kind: "desktop",
      agentId: "agent-1",
      desktop: { role: "control", controllerUserId: "user-1" },
    };
    const res = await beat({
      host: "d-agent-ab12-ctl.preview.test",
      userId: "user-1",
    });
    expect(res.status).toBe(200);
    expect(state.activity).toEqual([
      { agentId: "agent-1", userId: "user-1", role: "control" },
    ]);
    expect(state.previewActivity).toEqual([]);
  });

  it("the role is the api's own resolve of the host, never the relay's body", async () => {
    stubDesktop();
    state.host = {
      state: "ok",
      kind: "desktop",
      agentId: "agent-1",
      desktop: { role: "view", controllerUserId: "user-1" },
    };
    await beat({
      host: "d-agent-ab12.preview.test",
      userId: "user-1",
      role: "control",
    });
    expect(state.activity).toEqual([
      { agentId: "agent-1", userId: "user-1", role: "view" },
    ]);
  });

  it("a desktop beat without a viewer is passed on with no viewer", async () => {
    stubDesktop();
    state.host = {
      state: "ok",
      kind: "desktop",
      agentId: "agent-1",
      desktop: { role: "view", controllerUserId: null },
    };
    await beat({ host: "d-agent-ab12.preview.test" });
    expect(state.activity).toEqual([
      { agentId: "agent-1", userId: null, role: "view" },
    ]);
  });

  it.skipIf(IS_CLOUD)(
    "a desktop beat is a no-op without the implementation (every self-host)",
    async () => {
      state.host = {
        state: "ok",
        kind: "desktop",
        agentId: "agent-1",
        desktop: { role: "control", controllerUserId: "user-1" },
      };
      const res = await beat({ host: "d-agent-ab12-ctl.preview.test" });
      expect(res.status).toBe(200);
      expect(state.activity).toEqual([]);
      expect(state.previewActivity).toEqual([]);
    },
  );

  it("a preview host's beat is unchanged", async () => {
    state.host = { state: "ok", kind: "preview", agentId: "agent-1" };
    await beat({ host: "p8080-agent-ab12.preview.test", userId: "user-1" });
    expect(state.previewActivity).toEqual(["agent-1"]);
    expect(state.activity).toEqual([]);
  });
});
