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
 * The skill library over HTTP, real PostgreSQL, roles enforced: "Install
 * GitHub for skills only" connects the library from a signed grant with NO
 * org connection created, only an org admin may use it, one access source at
 * most, and the audit names the source by kind, never the grant. A switch
 * that drops skills agents use is a 409 with the impact until confirmed; an
 * agent's library reads are fenced to the caller's workspace; Re-sync is
 * audited. GitHub's HTTP API is the only stub.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: Awaited<ReturnType<typeof import("../app.js").createApiApp>>;
let privateKey = "";

const P = "sklib-rt-";
const ORG = `${P}org`;
const WS_A = `${P}ws-a`;
const WS_B = `${P}ws-b`;
const ADMIN = `${P}admin`;
const MEMBER = `${P}member`;
/** An admin of another org (the cross-tenant control). */
const OTHER_ORG = `${P}other-org`;
const OUTSIDER = `${P}outsider`;
const REPO = "acme/claude-skills";
const OTHER_REPO = "acme/other-skills";

const session = (user: string, workspaceId?: string) => ({
  "x-test-user": user,
  "x-organization-id": ORG,
  ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
  "content-type": "application/json",
});

const SKILL_MD =
  "---\nname: snowflake\ndescription: Query Snowflake\n---\nRUN\n";
const SKILL_PATH = "skills/snowflake/SKILL.md";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const stubGitHub = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/access_tokens"))
        return json(
          {
            token: "ghs_test",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: { contents: "read" },
          },
          201,
        );
      if (url.includes("/installation/repositories"))
        return json({ total_count: 1, repositories: [{ full_name: REPO }] });
      if (url.includes("/commits/main")) return json({ sha: "c1" });
      if (url.includes("/git/trees/"))
        return json({
          truncated: false,
          tree: [
            {
              path: SKILL_PATH,
              type: "blob",
              mode: "100644",
              sha: "blob-1",
              size: SKILL_MD.length,
            },
          ],
        });
      if (url.includes("/git/blobs/"))
        return json({
          encoding: "base64",
          content: Buffer.from(SKILL_MD).toString("base64"),
        });
      return json({}, 200);
    }),
  );

const cleanup = async () => {
  await db.skillSource.deleteMany({ where: { organizationId: ORG } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.appConnection.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({
    where: { userId: { in: [ADMIN, MEMBER, OUTSIDER] } },
  });
  await db.workspaceAccess.deleteMany({
    where: { workspaceId: { in: [WS_A, WS_B] } },
  });
  await db.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
  await db.organizationMember.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.user.deleteMany({
    where: { id: { in: [ADMIN, MEMBER, OUTSIDER] } },
  });
  await db.organization.deleteMany({
    where: { id: { in: [ORG, OTHER_ORG] } },
  });
};

describe.skipIf(!PROOF_URL)(
  "skill library connect over HTTP (real PostgreSQL)",
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
      Object.assign(process.env, {
        GITHUB_APP_ID: "123",
        GITHUB_APP_SLUG: "onecli-test",
        GITHUB_APP_PRIVATE_KEY: privateKey,
        // Its OAuth client: GitHub proves a user's access to an installation
        // (without it a skills-only install is refused).
        GITHUB_APP_CLIENT_ID: "Iv1.test",
        GITHUB_APP_CLIENT_SECRET: "test-secret",
      });

      ({ db } = await import("@onecli/db"));
      const providers = await import("../providers/index.js");
      const { getUserRole, eeWorkspaceAccessChecker } =
        await import("../ee/services/authorization-service.js");
      const { initWorkspaceAccessChecker } =
        await import("../providers/access-checker.js");
      providers.initRoleResolver({ getUserRole });
      initWorkspaceAccessChecker(eeWorkspaceAccessChecker);
      const env = await import("../lib/env.js");
      Object.defineProperty(env.CAPS, "rbac", {
        value: true,
        configurable: true,
      });
      const { createApiApp } = await import("../app.js");
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
      await db.organization.create({
        data: { id: ORG, name: ORG, slug: `${P}slug` },
      });
      await db.workspace.createMany({
        data: [
          { id: WS_A, name: "A", organizationId: ORG },
          { id: WS_B, name: "B", organizationId: ORG },
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
      // The member may use workspace A only; B is restricted.
      await db.workspaceAccess.create({
        data: { workspaceId: WS_A, userId: MEMBER },
      });
      stubGitHub();
    });

    afterEach(() => vi.unstubAllGlobals());

    afterAll(async () => {
      for (const k of [
        "GITHUB_APP_ID",
        "GITHUB_APP_SLUG",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_APP_CLIENT_ID",
        "GITHUB_APP_CLIENT_SECRET",
      ])
        delete process.env[k];
      if (!db) return;
      await cleanup();
      await db.$disconnect();
    });

    const grantFor = async (userId: string) => {
      const { signLibraryGrant } =
        await import("../services/skill-library-grant.js");
      return signLibraryGrant({
        organizationId: ORG,
        userId,
        grant: {
          installationId: "333",
          account: "acme",
          accountType: "Organization",
        },
      });
    };

    it("an admin connects from a skills-only grant: no connection, audited by kind", async () => {
      const grant = await grantFor(ADMIN);

      const repos = await app.request(
        "/v1/org/skill-library/access/repositories",
        {
          method: "POST",
          headers: session(ADMIN),
          body: JSON.stringify({ grant }),
        },
      );
      expect(repos.status).toBe(200);
      expect(await repos.json()).toEqual({
        repos: [REPO],
        truncated: false,
        // What the dialog's "Add it on GitHub" link opens.
        installation: {
          installationId: "333",
          account: "acme",
          accountType: "Organization",
        },
      });

      const res = await app.request("/v1/org/skill-library", {
        method: "PUT",
        headers: session(ADMIN),
        body: JSON.stringify({ grant, repo: REPO, branch: "main" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        repo: REPO,
        installationId: "333",
        appConnectionId: null,
      });
      expect(
        await db.appConnection.count({ where: { organizationId: ORG } }),
      ).toBe(0);

      const audit = await db.auditLog.findFirst({
        where: { userId: ADMIN },
        orderBy: { createdAt: "desc" },
      });
      expect(audit?.metadata).toMatchObject({
        repo: REPO,
        installationId: "333",
        access: "skills_only_install",
      });
      expect(JSON.stringify(audit?.metadata)).not.toContain(grant);
    });

    it("a member is refused, even holding a grant made for them", async () => {
      const grant = await grantFor(MEMBER);
      for (const [path, method] of [
        ["/v1/org/skill-library/access/repositories", "POST"],
        ["/v1/org/skill-library", "PUT"],
      ] as const) {
        const res = await app.request(path, {
          method,
          headers: session(MEMBER),
          body: JSON.stringify({ grant, repo: REPO }),
        });
        expect(res.status).toBe(403);
      }
      expect(
        await db.skillSource.count({ where: { organizationId: ORG } }),
      ).toBe(0);
    });

    it("another admin's grant is refused", async () => {
      const res = await app.request("/v1/org/skill-library", {
        method: "PUT",
        headers: session(ADMIN),
        body: JSON.stringify({ grant: await grantFor(MEMBER), repo: REPO }),
      });
      expect(res.status).toBe(403);
    });

    it("one access source at most", async () => {
      const res = await app.request("/v1/org/skill-library", {
        method: "PUT",
        headers: session(ADMIN),
        body: JSON.stringify({
          grant: await grantFor(ADMIN),
          appConnectionId: "conn-x",
          repo: REPO,
        }),
      });
      expect(res.status).toBe(422);
    });

    const seedAgent = (workspaceId: string, name: string) =>
      db.agent.create({
        data: {
          workspaceId,
          name,
          identifier: `${P}${name}`,
          accessToken: `aoc_${P}${name}`,
          kind: "hosted",
          harness: "fake",
        },
        select: { id: true },
      });

    const connectAndAdd = async () => {
      const put = await app.request("/v1/org/skill-library", {
        method: "PUT",
        headers: session(ADMIN),
        body: JSON.stringify({ grant: await grantFor(ADMIN), repo: REPO }),
      });
      expect(put.status).toBe(200);
      const restricted = await seedAgent(WS_B, "restricted");
      const added = await app.request(
        `/v1/agents/${restricted.id}/library-skills/snowflake`,
        { method: "PUT", headers: session(ADMIN, WS_B), body: "{}" },
      );
      expect(added.status).toBe(200);
      return restricted.id;
    };

    it("an agent's library reads are fenced to the caller's workspace", async () => {
      const restricted = await connectAndAdd();
      // The member, acting in the workspace they may use, names an agent of
      // a workspace they may not: NOT_FOUND, nothing disclosed.
      for (const path of [
        `/v1/agents/${restricted}/library-skills`,
        `/v1/agents/${restricted}/library-skills/available`,
      ]) {
        const res = await app.request(path, {
          headers: session(MEMBER, WS_A),
        });
        expect(res.status, path).toBe(404);
        expect(JSON.stringify(await res.json())).not.toContain("snowflake");
      }
      // An admin of that workspace reads it.
      const own = await app.request(`/v1/agents/${restricted}/library-skills`, {
        headers: session(ADMIN, WS_B),
      });
      expect(own.status).toBe(200);
      expect(await own.json()).toMatchObject({
        skills: [expect.objectContaining({ name: "snowflake" })],
      });
    });

    it("switching the repo while agents hold skills is a 409 with the impact until confirmed", async () => {
      await connectAndAdd();
      const usage = await app.request("/v1/org/skill-library", {
        headers: session(MEMBER),
      });
      expect(await usage.json()).toMatchObject({
        usage: { skillNames: ["snowflake"], agentCount: 1 },
      });

      const refused = await app.request("/v1/org/skill-library", {
        method: "PUT",
        headers: session(ADMIN),
        body: JSON.stringify({ repo: OTHER_REPO }),
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        error: {
          code: "replace_required",
          details: { skillNames: ["snowflake"], agentCount: 1 },
        },
      });
      // Nothing changed.
      expect(
        await db.skillSource.findUnique({
          where: { organizationId: ORG },
          select: { repo: true },
        }),
      ).toEqual({ repo: REPO });

      const confirmed = await app.request("/v1/org/skill-library", {
        method: "PUT",
        headers: session(ADMIN),
        body: JSON.stringify({ repo: OTHER_REPO, replace: true }),
      });
      expect(confirmed.status).toBe(200);
      expect(
        await db.librarySkill.count({
          where: { source: { organizationId: ORG } },
        }),
      ).toBe(0);
      const audit = await db.auditLog.findFirst({
        where: { userId: ADMIN, service: "skill-library", action: "update" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit?.metadata).toMatchObject({
        repo: OTHER_REPO,
        replaced: "true",
      });
    });

    it("Re-sync is audited with who ran it and the outcome", async () => {
      await connectAndAdd();
      const res = await app.request(
        "/v1/org/skill-library/skills/snowflake/syncs",
        { method: "POST", headers: session(MEMBER), body: "{}" },
      );
      expect(res.status).toBe(200);
      const audit = await db.auditLog.findFirst({
        where: { userId: MEMBER, service: "skill-library" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit?.metadata).toMatchObject({
        name: "snowflake",
        operation: "resync",
        commitSha: "c1",
        status: "current",
      });
    });

    it("someone outside the org reaches none of its library, read or write", async () => {
      await connectAndAdd();
      // An admin of ANOTHER org names this one.
      await db.organization.create({
        data: { id: OTHER_ORG, name: OTHER_ORG, slug: `${P}other` },
      });
      await db.user.create({
        data: {
          id: OUTSIDER,
          email: `${OUTSIDER}@example.com`,
          externalAuthId: `${OUTSIDER}-auth`,
        },
      });
      await db.organizationMember.create({
        data: {
          organizationId: OTHER_ORG,
          userId: OUTSIDER,
          userEmail: `${OUTSIDER}@example.com`,
          role: "admin",
        },
      });
      for (const [method, path] of [
        ["GET", "/v1/org/skill-library"],
        ["GET", "/v1/org/skill-library/repo-skills"],
        ["GET", "/v1/org/skill-library/github-accounts"],
        ["POST", "/v1/org/skill-library/skills/snowflake/syncs"],
        ["DELETE", "/v1/org/skill-library"],
      ] as const) {
        const res = await app.request(path, {
          method,
          headers: session(OUTSIDER),
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect([401, 403, 404], `${method} ${path}`).toContain(res.status);
        expect(await res.text()).not.toContain(REPO);
      }
      expect(
        await db.skillSource.count({ where: { organizationId: ORG } }),
      ).toBe(1);
    });

    it("a member can't list the org's GitHub accounts or disconnect", async () => {
      await connectAndAdd();
      const accounts = await app.request(
        "/v1/org/skill-library/github-accounts",
        { headers: session(MEMBER) },
      );
      expect(accounts.status).toBe(403);
      const disconnect = await app.request("/v1/org/skill-library", {
        method: "DELETE",
        headers: session(MEMBER),
      });
      expect(disconnect.status).toBe(403);
      expect(
        await db.skillSource.count({ where: { organizationId: ORG } }),
      ).toBe(1);
    });

    it("with the platform app unproven, skills-only is not offered and its grant is refused", async () => {
      // The env app IS the platform app here, with no OAuth client to prove
      // installation ids.
      vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
      vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");
      try {
        const read = await app.request("/v1/org/skill-library", {
          headers: session(ADMIN),
        });
        expect(await read.json()).toMatchObject({ skillsOnlyInstall: false });
        const put = await app.request("/v1/org/skill-library", {
          method: "PUT",
          headers: session(ADMIN),
          body: JSON.stringify({ grant: await grantFor(ADMIN), repo: REPO }),
        });
        expect(put.status).toBe(403);
        expect(
          await db.skillSource.count({ where: { organizationId: ORG } }),
        ).toBe(0);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  },
);
