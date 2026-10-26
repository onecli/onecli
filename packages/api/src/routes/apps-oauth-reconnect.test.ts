import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

/**
 * The OAuth callback, and who the connection it lands on is on for. The
 * connecting agent (`agent_id` at /authorize) rides the SIGNED state to the
 * callback, which turns a created connection on for it, and a fresh connect
 * that matches an existing account by name too. An explicit Reconnect of one
 * connection never grants anything: it only refreshes credentials. A foreign
 * agent is refused at /authorize, before any state is signed.
 */

const WORKSPACE_KEY = "oc_test-workspace-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
});

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    apiKey: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === WORKSPACE_KEY
          ? { userId: "user-1", workspaceId: "ws-1" }
          : null,
    },
    workspace: {
      findUnique: async () => ({ id: "ws-1", organizationId: "org-1" }),
      findFirst: async () => ({ id: "ws-1" }),
    },
    // The connecting-agent fence's lookup: only "agent-1" is ws-1's.
    agent: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; workspaceId: string };
      }) =>
        where.id === "agent-1" && where.workspaceId === "ws-1"
          ? { id: "agent-1" }
          : null,
    },
    user: {
      findUnique: async () => ({ email: "admin@example.com" }),
    },
  },
}));

vi.mock("../services/workspace-access-check", () => ({
  canAccessWorkspaceAsUser: async () => true,
}));

vi.mock("../apps/registry", () => ({
  getApp: (id: string) =>
    id === "mail"
      ? {
          id,
          name: "Mail",
          connectionMethod: {
            type: "oauth",
            defaultScopes: ["read"],
            buildAuthUrl: async () => "https://provider.example/auth",
            exchangeCode: async () => ({
              credentials: { access_token: "tok" },
              scopes: ["read"],
              metadata: { email: "Alex@Example.com" },
            }),
          },
        }
      : undefined,
  getApps: () => [],
}));

vi.mock("../apps/resolve-credentials", () => ({
  resolveAppCredentials: async () => ({
    values: { clientId: "cid", clientSecret: "cs" },
    appConfigId: "cfg-1",
  }),
}));

const calls = vi.hoisted(() => ({
  existing: [] as { id: string; label: string }[],
  reconnected: [] as string[],
  created: 0,
  granted: [] as {
    workspaceId: string;
    connectionId: string;
    agentId: string | undefined;
    userId: string | null;
  }[],
}));

vi.mock("../services/connection-service", () => ({
  listConnections: async () => [],
  listConnectionsByProvider: async () => calls.existing,
  createConnection: async () => {
    calls.created += 1;
    return { id: "conn-new" };
  },
  reconnectConnection: async (_scope: unknown, id: string) => {
    calls.reconnected.push(id);
    return { id };
  },
  linkConnectionToAppConfig: async () => undefined,
  findInstallationConnection: async () => null,
}));

// The real fence (`resolveConnectingAgent`, over the db mock above); only the
// grant itself is recorded.
vi.mock("../services/agent-connect-grant-service", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../services/agent-connect-grant-service")
    >();
  return {
    ...actual,
    grantConnectingAgent: async (
      workspaceId: string,
      connectionId: string,
      agentId: string | undefined,
      userId: string | null,
    ) => {
      calls.granted.push({ workspaceId, connectionId, agentId, userId });
    },
  };
});

vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCache: () => undefined,
  invalidateGatewayCacheForAccount: () => undefined,
}));

import { createApiApp } from "../app";

describe("OAuth callback onto an existing connection", () => {
  let app: Hono<ApiEnv>;

  beforeAll(() => {
    app = createApiApp({ getSession: async () => null });
  });

  beforeEach(() => {
    calls.existing = [];
    calls.reconnected.length = 0;
    calls.created = 0;
    calls.granted.length = 0;
  });

  const connect = async (query = "") => {
    const authorize = await app.request(`/v1/apps/mail/authorize${query}`, {
      headers: {
        authorization: `Bearer ${WORKSPACE_KEY}`,
        host: "api.example.com",
      },
    });
    expect(authorize.status).toBe(302);
    const state = decodeURIComponent(
      /oauth_state=([^;]+)/.exec(
        authorize.headers.get("set-cookie") ?? "",
      )![1]!,
    );
    const callback = await app.request(
      `/v1/apps/mail/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { host: "api.example.com" } },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("status=success");
  };

  it("a workspace connect creates the account and grants nobody", async () => {
    calls.existing = [{ id: "conn-other", label: "sam@example.com" }];
    await connect();
    expect(calls.created).toBe(1);
    expect(calls.granted).toEqual([
      {
        workspaceId: "ws-1",
        connectionId: "conn-new",
        agentId: undefined,
        userId: "user-1",
      },
    ]);
  });

  it("a connect from an agent turns the new account on for that agent", async () => {
    await connect("?agent_id=agent-1");
    expect(calls.created).toBe(1);
    expect(calls.granted).toEqual([
      {
        workspaceId: "ws-1",
        connectionId: "conn-new",
        agentId: "agent-1",
        userId: "user-1",
      },
    ]);
  });

  it("a fresh connect matching an account by name turns it on for the connecting agent", async () => {
    calls.existing = [{ id: "conn-old", label: "alex@example.com" }];
    await connect("?agent_id=agent-1");
    expect(calls.reconnected).toEqual(["conn-old"]);
    expect(calls.created).toBe(0);
    expect(calls.granted).toEqual([
      {
        workspaceId: "ws-1",
        connectionId: "conn-old",
        agentId: "agent-1",
        userId: "user-1",
      },
    ]);
  });

  it("an explicit Reconnect only refreshes credentials", async () => {
    calls.existing = [{ id: "conn-old", label: "alex@example.com" }];
    await connect("?connectionId=conn-old&agent_id=agent-1");
    expect(calls.reconnected).toEqual(["conn-old"]);
    expect(calls.granted).toEqual([]);
  });

  it("refuses a connecting agent outside the workspace before signing a state", async () => {
    const authorize = await app.request(
      "/v1/apps/mail/authorize?agent_id=agent-of-another-workspace",
      {
        headers: {
          authorization: `Bearer ${WORKSPACE_KEY}`,
          host: "api.example.com",
        },
      },
    );
    expect(authorize.status).toBe(404);
    expect(authorize.headers.get("set-cookie") ?? "").not.toContain(
      "oauth_state=",
    );
  });

  it("refuses an organization connect that names an agent, like every connect door", async () => {
    const authorize = await app.request(
      "/v1/apps/mail/authorize?_org=org-1&agent_id=agent-1",
      {
        headers: {
          authorization: `Bearer ${WORKSPACE_KEY}`,
          host: "api.example.com",
        },
      },
    );
    expect(authorize.status).toBe(400);
    expect(authorize.headers.get("set-cookie") ?? "").not.toContain(
      "oauth_state=",
    );
  });
});
