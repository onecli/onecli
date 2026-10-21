import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * Shared GitHub App installations on REAL PostgreSQL through the REAL HTTP
 * surface, with the production role gates (RBAC enforced). The service suite
 * proves the fence; this one proves the routes wire it the way the dashboard
 * calls them:
 *
 *   1. GET /v1/org/membership answers the caller's real role.
 *   2. Members are refused 403 on every share route, at both mounts.
 *   3. An admin shares an installation with the org: the connection moves up
 *      (same id, no copy), audited. Shared from an agent's page, it is on
 *      for that agent; a foreign agent is refused before anything moves.
 *   4. Another tenant's installation is invisible (404).
 *   5. The old capabilities route is gone.
 *
 * GitHub's HTTP API is the only stub. Env-gated like the other proof suites.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;

let db: Db;
let app: Awaited<ReturnType<typeof import("../app.js").createApiApp>>;
let privateKey = "";

const P = "ghshr-rt-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WS_A = `${P}ws-a`;
const WS_B = `${P}ws-b`;
const WS_OTHER = `${P}ws-other`;
const ADMIN = `${P}admin`;
const MEMBER = `${P}member`;
const AGENT_1 = `${P}agent-1`;
const AGENT_2 = `${P}agent-2`;
const GRANTED = ["acme/api", "acme/web"];

const session = (user: string, workspaceId?: string) => ({
  "x-test-user": user,
  "x-organization-id": ORG,
  ...(workspaceId && { "x-workspace-id": workspaceId }),
  "content-type": "application/json",
});

/** The agents holding a grant on `connectionId`, read through the real
 * grants route the post-connect dialog reads. */
const grantedAgents = async (connectionId: string) => {
  const res = await app.request(`/v1/connections/${connectionId}/grants`, {
    headers: session(ADMIN, WS_B),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { agents: { agentId: string }[] }).agents
    .map((a) => a.agentId)
    .sort();
};

const mockGitHub = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_test",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: { contents: "write", metadata: "read" },
          }),
          { status: 201 },
        );
      }
      if (url.includes("/installation/repositories")) {
        return new Response(
          JSON.stringify({
            total_count: GRANTED.length,
            repositories: GRANTED.map((full_name) => ({ full_name })),
          }),
          { status: 200 },
        );
      }
      // Gateway cache flushes and anything else: harmless.
      return new Response("{}", { status: 200 });
    }),
  );

const seedOriginal = async (
  scope: { workspaceId?: string; organizationId?: string },
  installationId: string,
) => {
  const { createConnection } = await import("../services/connection-service");
  return createConnection(
    scope,
    "github-app",
    {
      type: "github_app",
      installation_id: installationId,
      app_id: "123",
      private_key: privateKey,
      access_token: "ghs_seed",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
    {
      metadata: {
        username: "acme",
        accountType: "Organization",
        installationId,
        repositorySelection: "all",
        repos: GRANTED,
      },
    },
  );
};

const cleanup = async () => {
  const wss = [WS_A, WS_B, WS_OTHER];
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { organizationId: { in: [ORG, OTHER_ORG] } },
        { workspaceId: { in: wss } },
      ],
    },
  });
  await db.appConnection.deleteMany({
    where: {
      sourceConnectionId: { not: null },
      OR: [
        { organizationId: { in: [ORG, OTHER_ORG] } },
        { workspaceId: { in: wss } },
      ],
    },
  });
  await db.appConnection.deleteMany({
    where: {
      OR: [
        { organizationId: { in: [ORG, OTHER_ORG] } },
        { workspaceId: { in: wss } },
      ],
    },
  });
  await db.agent.deleteMany({ where: { workspaceId: { in: wss } } });
  await db.auditLog.deleteMany({ where: { userId: { in: [ADMIN, MEMBER] } } });
  await db.workspaceAccess.deleteMany({ where: { workspaceId: { in: wss } } });
  await db.workspace.deleteMany({ where: { id: { in: wss } } });
  await db.organizationMember.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.user.deleteMany({ where: { id: { in: [ADMIN, MEMBER] } } });
  await db.organization.deleteMany({
    where: { id: { in: [ORG, OTHER_ORG] } },
  });
};

describe.skipIf(!PROOF_URL)(
  "shared GitHub App installations over HTTP (real PostgreSQL)",
  () => {
    beforeAll(async () => {
      process.env.DATABASE_URL = PROOF_URL;
      process.env.NEXT_PUBLIC_EDITION = "onprem";
      process.env.SECRET_ENCRYPTION_KEY =
        "7eeHVTcHkPw4rfI6wb0LSZje0mKDphzuz8QLocq0Egw=";
      process.env.OAUTH_STATE_SECRET = "proof-oauth-state-secret";
      const { generateKeyPairSync } = await import("crypto");
      privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs1", format: "pem" })
        .toString();

      ({ db } = await import("@onecli/db"));
      const { createApiApp } = await import("../app.js");
      const providers = await import("../providers/index.js");
      const { getUserRole, eeWorkspaceAccessChecker } =
        await import("../ee/services/authorization-service.js");
      const { initWorkspaceAccessChecker } =
        await import("../providers/access-checker.js");
      providers.initRoleResolver({ getUserRole });
      initWorkspaceAccessChecker(eeWorkspaceAccessChecker);
      // Roles enforced for real, so a member's 403 is the gate.
      const env = await import("../lib/env.js");
      Object.defineProperty(env.CAPS, "rbac", {
        value: true,
        configurable: true,
      });

      app = createApiApp({
        getSession: async (request: Request) => {
          const who = request.headers.get("x-test-user");
          return who
            ? { id: `${who}-auth`, email: `${who}@example.com` }
            : null;
        },
      });
    });

    beforeEach(async () => {
      await cleanup();
      await db.organization.createMany({
        data: [
          { id: ORG, name: ORG, slug: `${P}slug` },
          { id: OTHER_ORG, name: OTHER_ORG, slug: `${P}other-slug` },
        ],
      });
      for (const [id, role] of [
        [ADMIN, "admin"],
        [MEMBER, "member"],
      ] as const) {
        await db.user.create({
          data: {
            id,
            email: `${id}@example.com`,
            externalAuthId: `${id}-auth`,
          },
        });
        await db.organizationMember.create({
          data: {
            organizationId: ORG,
            userId: id,
            userEmail: `${id}@example.com`,
            role,
          },
        });
      }
      await db.workspace.createMany({
        data: [
          { id: WS_A, name: WS_A, organizationId: ORG },
          { id: WS_B, name: WS_B, organizationId: ORG },
          { id: WS_OTHER, name: WS_OTHER, organizationId: OTHER_ORG },
        ],
      });
      // The member owns WS_B: full workspace rights, still not an org admin.
      await db.workspaceAccess.create({
        data: { workspaceId: WS_B, userId: MEMBER, role: "owner" },
      });
      await db.agent.createMany({
        data: [AGENT_1, AGENT_2].map((id) => ({
          id,
          name: id,
          identifier: id,
          accessToken: `aoc_${id}`,
          workspaceId: WS_B,
        })),
      });
      mockGitHub();
    });

    afterEach(() => vi.unstubAllGlobals());

    afterAll(async () => {
      if (!db) return;
      await cleanup();
      await db.$disconnect();
    });

    it("GET /v1/org/membership answers the caller's real role", async () => {
      for (const [user, isAdmin] of [
        [ADMIN, true],
        [MEMBER, false],
      ] as const) {
        const res = await app.request("/v1/org/membership", {
          headers: session(user, WS_B),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ isAdmin });
      }
    });

    it("refuses a member on every share route, at both mounts", async () => {
      const source = await seedOriginal({ workspaceId: WS_A }, "111");
      const calls: [string, string, RequestInit][] = [
        ["GET", "/v1/apps/github-app/installations", {}],
        [
          "POST",
          "/v1/apps/github-app/connections",
          { body: JSON.stringify({ sourceConnectionId: source.id }) },
        ],
        ["GET", "/v1/org/apps/github-app/installations", {}],
        [
          "POST",
          "/v1/org/apps/github-app/connections",
          { body: JSON.stringify({ sourceConnectionId: source.id }) },
        ],
      ];
      for (const [method, path, init] of calls) {
        const res = await app.request(path, {
          method,
          headers: session(MEMBER, WS_B),
          ...init,
        });
        expect(res.status, `${method} ${path}`).toBe(403);
      }
      expect(
        (await db.appConnection.findUniqueOrThrow({ where: { id: source.id } }))
          .scope,
      ).toBe("workspace");
    });

    it("an admin shares an installation with the org: it moves up, audited, no copy", async () => {
      const source = await seedOriginal({ workspaceId: WS_A }, "111");

      const list = await app.request("/v1/apps/github-app/installations", {
        headers: session(ADMIN, WS_B),
      });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject([
        { sourceConnectionId: source.id, connectedHere: 0 },
      ]);

      const shared = await app.request("/v1/apps/github-app/connections", {
        method: "POST",
        headers: session(ADMIN, WS_B),
        body: JSON.stringify({ sourceConnectionId: source.id }),
      });
      expect(shared.status).toBe(200);
      expect(((await shared.json()) as { id: string }).id).toBe(source.id);

      const row = await db.appConnection.findUniqueOrThrow({
        where: { id: source.id },
      });
      expect(row).toMatchObject({
        scope: "organization",
        organizationId: ORG,
        workspaceId: null,
      });
      expect(
        await db.appConnection.count({
          where: {
            provider: "github-app",
            OR: [
              { organizationId: ORG },
              { workspaceId: { in: [WS_A, WS_B] } },
            ],
          },
        }),
      ).toBe(1);

      const audit = await db.auditLog.findFirst({
        where: { userId: ADMIN, action: "update" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit?.metadata).toEqual({
        connectionId: source.id,
        provider: "github-app",
        change: "promoted_to_organization",
      });
      expect(JSON.stringify(audit?.metadata)).not.toMatch(/ghs_|PRIVATE KEY/);
      // Shared from the Connections page: on for no new agent.
      expect(await grantedAgents(source.id)).toEqual([]);
      const again = await app.request("/v1/apps/github-app/connections", {
        method: "POST",
        headers: session(ADMIN, WS_B),
        body: JSON.stringify({ sourceConnectionId: source.id }),
      });
      expect(again.status).toBe(409);
    });

    it("edit a connection's repositories over HTTP: audited without secrets; members refused", async () => {
      const source = await seedOriginal({ workspaceId: WS_B }, "111");
      for (const [method, path, init] of [
        [
          "GET",
          `/v1/apps/github-app/connections/${source.id}/repositories`,
          {},
        ],
        [
          "PATCH",
          `/v1/apps/github-app/connections/${source.id}`,
          { body: JSON.stringify({ repositories: ["acme/web"] }) },
        ],
      ] as [string, string, RequestInit][]) {
        const res = await app.request(path, {
          method,
          headers: session(MEMBER, WS_B),
          ...init,
        });
        expect(res.status, `${method} ${path}`).toBe(403);
      }

      const listed = await app.request(
        `/v1/apps/github-app/connections/${source.id}/repositories`,
        { headers: session(ADMIN, WS_B) },
      );
      expect(await listed.json()).toEqual({
        available: GRANTED,
        truncated: false,
        selected: null,
      });

      const edited = await app.request(
        `/v1/apps/github-app/connections/${source.id}`,
        {
          method: "PATCH",
          headers: session(ADMIN, WS_B),
          body: JSON.stringify({ repositories: ["acme/web"] }),
        },
      );
      expect(edited.status).toBe(200);
      expect(await edited.json()).toEqual({
        id: source.id,
        repositories: ["acme/web"],
      });
      const audit = await db.auditLog.findFirst({
        where: { userId: ADMIN, action: "update" },
        orderBy: { createdAt: "desc" },
      });
      // Exactly ids and a count: nothing else (no token, key or repo names).
      expect(audit?.metadata).toEqual({
        connectionId: source.id,
        provider: "github-app",
        repositories: 1,
      });
      expect(JSON.stringify(audit?.metadata)).not.toMatch(/ghs_|PRIVATE KEY/);

      // A workspace route never reaches another workspace's row.
      const crossed = await app.request(
        `/v1/apps/github-app/connections/${source.id}`,
        {
          method: "PATCH",
          headers: session(ADMIN, WS_A),
          body: JSON.stringify({ repositories: null }),
        },
      );
      expect(crossed.status).toBe(404);
    });

    it("shared from an agent's page: on for that agent alone", async () => {
      const source = await seedOriginal({ workspaceId: WS_A }, "111");

      const created = await app.request("/v1/apps/github-app/connections", {
        method: "POST",
        headers: session(ADMIN, WS_B),
        body: JSON.stringify({
          sourceConnectionId: source.id,
          agentId: AGENT_1,
        }),
      });
      expect(created.status).toBe(200);
      const body = (await created.json()) as { id: string };

      const grants = await app.request(`/v1/connections/${body.id}/grants`, {
        headers: session(ADMIN, WS_B),
      });
      const grantBody = (await grants.json()) as {
        agents: { agentId: string; resources: unknown }[];
      };
      expect(grantBody.agents.map((a) => a.agentId)).toEqual([AGENT_1]);
      // The grants view carries `resources` (null = unrestricted).
      expect(grantBody.agents[0]).toHaveProperty("resources", null);
    });

    it("GET is read-only, PATCH requires repositories and POST refresh persists with a safe audit", async () => {
      for (const [target, mount, workspaceId] of [
        [{ workspaceId: WS_B }, "/v1/apps", WS_B],
        [{ organizationId: ORG }, "/v1/org/apps", undefined],
      ] as const) {
        const source = await seedOriginal(target, workspaceId ? "111" : "222");
        const before = await db.appConnection.update({
          where: { id: source.id },
          data: {
            metadata: {
              username: "acme",
              repos: ["acme/old"],
              repositorySelection: "all",
            },
          },
        });
        const root = `${mount}/github-app/connections/${source.id}`;
        const auditsBefore = await db.auditLog.count({
          where: { userId: ADMIN },
        });
        const listed = await app.request(`${root}/repositories`, {
          headers: session(ADMIN, workspaceId),
        });
        expect(listed.status).toBe(200);
        expect(await listed.json()).toEqual({
          available: GRANTED,
          truncated: false,
          selected: null,
        });
        expect(
          await db.appConnection.findUniqueOrThrow({
            where: { id: source.id },
          }),
        ).toEqual(before);
        expect(await db.auditLog.count({ where: { userId: ADMIN } })).toBe(
          auditsBefore,
        );
        const invalid = await app.request(root, {
          method: "PATCH",
          headers: session(ADMIN, workspaceId),
          body: "{}",
        });
        expect(invalid.status).toBe(400);
        expect(
          await db.appConnection.findUniqueOrThrow({
            where: { id: source.id },
          }),
        ).toEqual(before);
        const denied = await app.request(`${root}/repository-refresh`, {
          method: "POST",
          headers: session(MEMBER, workspaceId),
        });
        expect(denied.status).toBe(403);
        const refreshed = await app.request(`${root}/repository-refresh`, {
          method: "POST",
          headers: session(ADMIN, workspaceId),
        });
        expect(refreshed.status).toBe(200);
        expect(await refreshed.json()).toEqual({
          available: GRANTED,
          truncated: false,
          selected: null,
        });
        const after = await db.appConnection.findUniqueOrThrow({
          where: { id: source.id },
        });
        expect(after.credentials).toBe(before.credentials);
        expect(after.metadata).toMatchObject({
          username: "acme",
          repos: GRANTED,
        });
        const audit = await db.auditLog.findFirst({
          where: { userId: ADMIN, action: "update" },
          orderBy: { createdAt: "desc" },
        });
        expect(audit?.metadata).toEqual({
          connectionId: source.id,
          provider: "github-app",
          change: "repositories_refreshed",
        });
        expect(JSON.stringify(audit?.metadata)).not.toMatch(
          /ghs_|PRIVATE KEY|acme\//,
        );
        expect(await db.auditLog.count({ where: { userId: ADMIN } })).toBe(
          auditsBefore + 1,
        );
      }
    });

    it("refuses an agent of another workspace before creating anything", async () => {
      const source = await seedOriginal({ workspaceId: WS_A }, "111");
      await db.agent.create({
        data: {
          id: `${P}agent-ws-a`,
          name: "Other workspace agent",
          identifier: `${P}agent-ws-a`,
          accessToken: `aoc_${P}agent-ws-a`,
          workspaceId: WS_A,
        },
      });

      const res = await app.request("/v1/apps/github-app/connections", {
        method: "POST",
        headers: session(ADMIN, WS_B),
        body: JSON.stringify({
          sourceConnectionId: source.id,
          agentId: `${P}agent-ws-a`,
        }),
      });
      expect(res.status).toBe(404);
      expect(
        (await db.appConnection.findUniqueOrThrow({ where: { id: source.id } }))
          .scope,
      ).toBe("workspace");
    });

    it("another tenant's installation is invisible, even by id", async () => {
      const foreign = await seedOriginal({ workspaceId: WS_OTHER }, "999");
      const list = await app.request("/v1/apps/github-app/installations", {
        headers: session(ADMIN, WS_B),
      });
      expect(await list.json()).toEqual([]);
      const res = await app.request("/v1/apps/github-app/connections", {
        method: "POST",
        headers: session(ADMIN, WS_B),
        body: JSON.stringify({ sourceConnectionId: foreign.id }),
      });
      expect(res.status).toBe(404);
    });

    it("the capabilities route is gone", async () => {
      const capabilities = await app.request("/v1/connections/capabilities", {
        headers: session(ADMIN, WS_B),
      });
      expect(capabilities.status).not.toBe(200);
    });
  },
);
