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
 *   3. An admin lists, reads repos and shares; the new connection is audited
 *      and arrives granted to every agent of the workspace (auto-attach ran
 *      inside the audited action).
 *   4. Another tenant's installation is invisible (404).
 *   5. Promote refuses a shared connection (422); the old capabilities route
 *      is gone.
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
          "GET",
          `/v1/apps/github-app/installations/${source.id}/repositories`,
          {},
        ],
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
        await db.appConnection.count({
          where: { sourceConnectionId: source.id },
        }),
      ).toBe(0);
    });

    it("an admin shares into a workspace: audited, pinned, granted to every agent", async () => {
      const source = await seedOriginal({ workspaceId: WS_A }, "111");

      const list = await app.request("/v1/apps/github-app/installations", {
        headers: session(ADMIN, WS_B),
      });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject([
        { sourceConnectionId: source.id, origin: "another_workspace" },
      ]);

      const repos = await app.request(
        `/v1/apps/github-app/installations/${source.id}/repositories`,
        { headers: session(ADMIN, WS_B) },
      );
      expect(await repos.json()).toEqual({ repos: GRANTED, truncated: false });

      const created = await app.request("/v1/apps/github-app/connections", {
        method: "POST",
        headers: session(ADMIN, WS_B),
        body: JSON.stringify({
          sourceConnectionId: source.id,
          repositories: ["acme/web"],
        }),
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as { id: string };

      const row = await db.appConnection.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(row).toMatchObject({
        workspaceId: WS_B,
        sourceConnectionId: source.id,
      });

      // Audited, with ids only (no token or key in the metadata).
      const audit = await db.auditLog.findFirst({
        where: { userId: ADMIN, action: "create" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit?.metadata).toMatchObject({
        connectionId: body.id,
        sourceConnectionId: source.id,
        repositories: ["acme/web"],
      });
      expect(JSON.stringify(audit?.metadata)).not.toMatch(/ghs_|PRIVATE KEY/);

      // Every agent of the workspace holds a grant on the new connection.
      const grants = await app.request(`/v1/connections/${body.id}/grants`, {
        headers: session(ADMIN, WS_B),
      });
      expect(grants.status).toBe(200);
      const grantBody = (await grants.json()) as {
        agents: { agentId: string; resources: unknown }[];
      };
      expect(grantBody.agents.map((a) => a.agentId).sort()).toEqual([
        AGENT_1,
        AGENT_2,
      ]);
      // The grants view now carries `resources` (null = unrestricted).
      expect(grantBody.agents[0]).toHaveProperty("resources", null);
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

    it("promote refuses a shared connection; the capabilities route is gone", async () => {
      const source = await seedOriginal({ workspaceId: WS_A }, "111");
      const created = (await (
        await app.request("/v1/apps/github-app/connections", {
          method: "POST",
          headers: session(ADMIN, WS_B),
          body: JSON.stringify({
            sourceConnectionId: source.id,
            repositories: ["acme/web"],
          }),
        })
      ).json()) as { id: string };

      const promote = await app.request(
        `/v1/connections/${created.id}/promote`,
        { method: "POST", headers: session(ADMIN, WS_B), body: "{}" },
      );
      expect(promote.status).toBe(422);
      const memberPromote = await app.request(
        `/v1/connections/${source.id}/promote`,
        { method: "POST", headers: session(MEMBER, WS_B), body: "{}" },
      );
      expect(memberPromote.status).toBe(403);

      const capabilities = await app.request("/v1/connections/capabilities", {
        headers: session(ADMIN, WS_B),
      });
      expect(capabilities.status).not.toBe(200);
    });
  },
);
