import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ApiEnv } from "../types";

/**
 * The GitHub App connect, end to end through the real routes and the real
 * `githubApp` definition: `/authorize`, GitHub's setup redirect back to the
 * callback, then GitHub's web-flow return. Only the DB, credential resolution
 * and GitHub itself are stubbed. With the platform app's OAuth client
 * configured, a setup redirect stores nothing and detours through GitHub; the
 * return connects only an installation the user can access, and only in the
 * browser that ran `/authorize`.
 *
 * Onprem-pinned in its own file: the edition is read at module load.
 */

const WORKSPACE_KEY = "oc_test-workspace-key";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
  delete process.env.API_URL;
});

const PLATFORM_APP_ID = "1000";
const CALLBACK = "/v1/apps/github-app/callback";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const created = vi.hoisted(() => [] as Record<string, unknown>[]);
// Where the installation is already connected in the org (null = nowhere).
const alreadyConnected = vi.hoisted(() => ({
  row: null as null | {
    id: string;
    scope: string;
    workspaceId: string | null;
  },
}));
const storedIdentity = vi.hoisted(() => ({
  appId: "1000",
  installationId: "111",
}));
const reconnects = vi.hoisted(() => [] as string[]);
const granted = vi.hoisted(
  () => [] as { connectionId: string; agentId: string | undefined }[],
);

vi.mock("@onecli/db", () => ({
  Prisma: { TransactionIsolationLevel: { ReadCommitted: "ReadCommitted" } },
  db: {
    $transaction: async <T>(run: (tx: unknown) => Promise<T>) =>
      run({
        $queryRaw: async () => [{ locked: 1 }],
        workspace: { findFirst: async () => ({ id: "ws-1" }) },
        appConnection: {
          findFirst: async () => ({
            credentials: await (await import("../providers"))
              .getCrypto()
              .encrypt(
                JSON.stringify({
                  type: "github_app",
                  app_id: storedIdentity.appId,
                  installation_id: storedIdentity.installationId,
                  private_key: privateKey,
                }),
              ),
          }),
        },
      }),
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
    user: {
      findUnique: async () => ({ email: "admin@example.com" }),
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
  },
}));

vi.mock("../services/home-sync-service", () => ({
  bumpHomeForScope: async () => {},
}));

vi.mock("../services/workspace-access-check", () => ({
  canAccessWorkspaceAsUser: async () => true,
}));

vi.mock("../apps/resolve-credentials", () => ({
  resolveAppCredentials: async () => ({
    values: { appId: PLATFORM_APP_ID, appSlug: "onecli", privateKey },
    source: "env",
  }),
}));

vi.mock("../services/connection-service", () => ({
  listConnections: async () => [],
  listConnectionsByProvider: async () => [],
  createConnection: async (
    _scope: unknown,
    _provider: string,
    credentials: Record<string, unknown>,
  ) => {
    created.push(credentials);
    return { id: "conn-new" };
  },
  reconnectConnection: async (_scope: unknown, id: string) => {
    reconnects.push(id);
    return { id };
  },
  linkConnectionToAppConfig: async () => undefined,
  findInstallationConnection: async () => alreadyConnected.row,
}));

// The real fence; only the grant is recorded.
vi.mock("../services/agent-connect-grant-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/agent-connect-grant-service")
  >()),
  grantConnectingAgent: async (
    _workspaceId: string,
    connectionId: string,
    agentId: string | undefined,
  ) => {
    granted.push({ connectionId, agentId });
  },
}));

vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCache: () => undefined,
  invalidateGatewayCacheForAccount: () => undefined,
}));

import { createApiApp } from "../app";

/** GitHub: the connecting user can access installation 111 only. */
const stubGitHub = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token")
        return Response.json({ access_token: "ghu_user" });
      if (url.includes("/user/installations"))
        return Response.json({ installations: [{ id: 111 }] });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const mint = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
      if (mint)
        return Response.json({
          token: `ghs_${mint[1]}`,
          expires_at: "2099-01-01T00:00:00Z",
        });
      return Response.json({});
    }),
  );

/** The `oauth_state` cookie a response sets, decoded. */
const stateCookie = (res: Response): string => {
  const match = /oauth_state=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (!match) throw new Error("expected an oauth_state cookie");
  return decodeURIComponent(match[1]!);
};

describe("GitHub App connect through /authorize and the callback (platform app)", () => {
  let app: Hono<ApiEnv>;
  beforeAll(() => {
    app = createApiApp({ getSession: async () => null });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    created.length = 0;
    granted.length = 0;
    alreadyConnected.row = null;
    storedIdentity.appId = PLATFORM_APP_ID;
    storedIdentity.installationId = "111";
    reconnects.length = 0;
  });

  const configure = () => {
    vi.stubEnv("GITHUB_APP_ID", PLATFORM_APP_ID);
    vi.stubEnv("GITHUB_APP_SLUG", "onecli");
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.client");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "s3cret");
    stubGitHub();
  };

  /** `/authorize` in the user's browser; returns the state it signed. */
  const authorize = async (query = "") => {
    const res = await app.request(`/v1/apps/github-app/authorize${query}`, {
      headers: {
        authorization: `Bearer ${WORKSPACE_KEY}`,
        host: "api.example.com",
      },
    });
    expect(res.status).toBe(302);
    return stateCookie(res);
  };

  const callback = (query: Record<string, string>, cookie?: string) =>
    app.request(`${CALLBACK}?${new URLSearchParams(query)}`, {
      headers: {
        host: "api.example.com",
        ...(cookie
          ? { cookie: `oauth_state=${encodeURIComponent(cookie)}` }
          : {}),
      },
    });

  /** GitHub's setup redirect back to this browser; returns leg 2's state. */
  const setupRedirect = async (installationId: string, query = "") => {
    const state = await authorize(query);
    const res = await callback(
      { installation_id: installationId, setup_action: "update", state },
      state,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    const next = location.searchParams.get("state")!;
    expect(stateCookie(res)).toBe(next);
    return next;
  };

  it("a setup redirect (install or update) stores nothing and detours through GitHub", async () => {
    configure();
    await setupRedirect("111", "?agent_id=agent-1");
    expect(created).toEqual([]);
    expect(granted).toEqual([]);
  });

  it("GitHub's return connects the user's own installation", async () => {
    configure();
    const next = await setupRedirect("111");

    const res = await callback({ code: "user-code", state: next }, next);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("status=success");
    expect(created).toEqual([
      expect.objectContaining({
        installation_id: "111",
        access_token: "ghs_111",
      }),
    ]);
    // A workspace connect: on for nobody.
    expect(granted).toEqual([{ connectionId: "conn-new", agentId: undefined }]);
  });

  it("never connects twice a GitHub account the org already has: back from GitHub it lands on 'updated'", async () => {
    for (const row of [
      { id: "conn-org", scope: "organization", workspaceId: null },
      { id: "conn-ws2", scope: "workspace", workspaceId: "ws-2" },
    ]) {
      configure();
      alreadyConnected.row = row;
      const next = await setupRedirect("111");
      const res = await callback({ code: "user-code", state: next }, next);
      expect(res.headers.get("location")).toContain("status=updated");
      expect(created).toEqual([]);
    }
  });

  it("re-connecting an installation this workspace already has refreshes it in place", async () => {
    configure();
    alreadyConnected.row = {
      id: "conn-old",
      scope: "workspace",
      workspaceId: "ws-1",
    };
    const next = await setupRedirect("111");
    const res = await callback({ code: "user-code", state: next }, next);
    expect(res.headers.get("location")).toContain("status=success");
    expect(created).toEqual([]);
  });

  it("explicit reconnect still dedupes an installation owned by another scope", async () => {
    configure();
    alreadyConnected.row = {
      id: "conn-org",
      scope: "organization",
      workspaceId: null,
    };
    const next = await setupRedirect(
      "111",
      "?connectionId=conn-old&agent_id=agent-1",
    );
    const res = await callback({ code: "user-code", state: next }, next);
    expect(res.headers.get("location")).toContain("status=updated");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(reconnects).toEqual([]);
    expect(created).toEqual([]);
    expect(granted).toEqual([]);
  });

  it("explicit reconnect refreshes only the same installation and never grants the connecting agent", async () => {
    configure();
    alreadyConnected.row = {
      id: "conn-old",
      scope: "workspace",
      workspaceId: "ws-1",
    };
    const next = await setupRedirect(
      "111",
      "?connectionId=conn-old&agent_id=agent-1",
    );
    const res = await callback({ code: "user-code", state: next }, next);
    expect(res.headers.get("location")).toContain("status=success");
    expect(reconnects).toEqual(["conn-old"]);
    expect(created).toEqual([]);
    expect(granted).toEqual([]);
    expect(res.headers.get("location")).not.toContain("connected=");
  });

  it.each(["appId", "installationId"] as const)(
    "explicit reconnect rejects a mismatched stored %s",
    async (field) => {
      configure();
      storedIdentity[field] = "999";
      const next = await setupRedirect("111", "?connectionId=conn-old");
      const res = await callback({ code: "user-code", state: next }, next);
      expect(res.headers.get("location")).toContain("status=error");
      expect(reconnects).toEqual([]);
      expect(created).toEqual([]);
      expect(granted).toEqual([]);
    },
  );

  it("keeps the connecting agent across GitHub's two legs, so the installation lands on for it", async () => {
    configure();
    const next = await setupRedirect("111", "?agent_id=agent-1");

    const res = await callback({ code: "user-code", state: next }, next);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("status=success");
    expect(granted).toEqual([{ connectionId: "conn-new", agentId: "agent-1" }]);
  });

  it("refuses another tenant's installation id", async () => {
    configure();
    const next = await setupRedirect("999");

    const res = await callback({ code: "user-code", state: next }, next);

    expect(decodeURIComponent(res.headers.get("location")!)).toContain(
      "status=error&message=You don't have access to this GitHub installation.",
    );
    expect(created).toEqual([]);
  });

  it("refuses GitHub's return in a browser that did not start it", async () => {
    configure();
    const next = await setupRedirect("111");

    const res = await callback({ code: "user-code", state: next });

    expect(res.headers.get("location")).toContain("status=error");
    expect(created).toEqual([]);
  });

  it("a repo change made on GitHub (no connect in flight) lands on 'updated' and stores nothing", async () => {
    configure();
    const res = await callback({
      installation_id: "111",
      setup_action: "update",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "/app-connect/github-app?status=updated",
    );
    expect(created).toEqual([]);
  });

  it("refuses a crafted setup link opened in another browser (no /authorize there)", async () => {
    configure();
    // The attacker's own state, opened by a victim whose browser never ran
    // /authorize for it: no detour, nothing stored.
    const attackerState = await authorize();

    const res = await callback({
      installation_id: "111",
      setup_action: "install",
      state: attackerState,
    });

    expect(res.headers.get("location")).toContain("status=error");
    expect(res.headers.get("location")).not.toContain("github.com");
    expect(created).toEqual([]);
  });

  it("refuses a non-numeric installation id", async () => {
    configure();
    const state = await authorize();

    const res = await callback({ installation_id: "1/../../x", state }, state);

    expect(decodeURIComponent(res.headers.get("location")!)).toContain(
      "status=error&message=Invalid GitHub installation",
    );
    expect(created).toEqual([]);
  });

  it("a self-host without the platform OAuth client connects directly (cloud refuses: github-app.test.ts)", async () => {
    vi.stubEnv("GITHUB_APP_ID", PLATFORM_APP_ID);
    vi.stubEnv("GITHUB_APP_SLUG", "onecli");
    stubGitHub();
    const state = await authorize();

    const res = await callback(
      { installation_id: "111", setup_action: "install", state },
      state,
    );

    expect(res.headers.get("location")).toContain("status=success");
    expect(created).toEqual([
      expect.objectContaining({ installation_id: "111" }),
    ]);
  });
});
