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
 * Org-shared vendor OAuth clients on REAL PostgreSQL through the REAL HTTP
 * surface. The product rule under proof:
 *
 *   1. An org admin saves a client ID/secret on ONE Google app (Gmail) and it
 *      is stored once, as the org's `google` row.
 *   2. Every Google app, in every workspace, then resolves that client.
 *   3. A workspace admin saving on ANY Google app (Drive) creates a workspace
 *      `google` override: that workspace's Google apps use it, other
 *      workspaces keep the org client.
 *   4. Removing the override returns the workspace to the org client.
 *   5. Only admins can write workspace credentials (a member gets 403).
 *
 * Env-gated like the other proof suites: skipped unless
 * POLICY_PROOF_DATABASE_URL points at a migrated PostgreSQL.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;

let db: Db;
let app: Awaited<ReturnType<typeof import("../app.js").createApiApp>>;
let resolveAppCredentials: typeof import("../apps/resolve-credentials.js").resolveAppCredentials;
let getApp: typeof import("../apps/registry.js").getApp;

const P = "oauthgrp-";
const ORG = `${P}org`;
const WS_A = `${P}ws-a`;
const WS_B = `${P}ws-b`;
const ADMIN = `${P}admin`;
const MEMBER = `${P}member`;

const session = (user: string, workspaceId?: string) => ({
  "x-test-user": user,
  "x-organization-id": ORG,
  ...(workspaceId && { "x-workspace-id": workspaceId }),
  "content-type": "application/json",
});

const clientIdFor = async (workspaceId: string, appId: string) =>
  (await resolveAppCredentials(workspaceId, getApp(appId)!, ORG))?.values
    .clientId;

describe.skipIf(!PROOF_URL)(
  "org-shared vendor OAuth clients (real PostgreSQL)",
  () => {
    beforeAll(async () => {
      process.env.DATABASE_URL = PROOF_URL;
      // onprem edition (local crypto, no KMS) with the REAL EE role resolver and
      // workspace access checker wired in and CAPS.rbac forced on, so admin vs
      // member is decided by the production gates.
      process.env.NEXT_PUBLIC_EDITION = "onprem";
      process.env.SECRET_ENCRYPTION_KEY =
        "7eeHVTcHkPw4rfI6wb0LSZje0mKDphzuz8QLocq0Egw=";
      process.env.OAUTH_STATE_SECRET = "proof-oauth-state-secret";
      // No platform Google/Atlassian client: anything resolved came from a row.
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;

      ({ db } = await import("@onecli/db"));
      const { createApiApp } = await import("../app.js");
      const providers = await import("../providers/index.js");
      const { getUserRole, eeWorkspaceAccessChecker } =
        await import("../ee/services/authorization-service.js");
      const { orgAppConfig } = await import("../apps/org-app-config.js");
      const { initWorkspaceAccessChecker } =
        await import("../providers/access-checker.js");
      providers.initRoleResolver({ getUserRole });
      initWorkspaceAccessChecker(eeWorkspaceAccessChecker);
      providers.initOrgAppConfig(orgAppConfig);
      ({ resolveAppCredentials } =
        await import("../apps/resolve-credentials.js"));
      ({ getApp } = await import("../apps/registry.js"));

      // Enforce roles for real (CAPS.rbac), so the member 403 is the gate, not
      // a coincidence.
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
      await db.appConnection.deleteMany({
        where: {
          OR: [{ organizationId: ORG }, { workspaceId: { in: [WS_A, WS_B] } }],
        },
      });
      await db.appConfig.deleteMany({
        where: {
          OR: [{ organizationId: ORG }, { workspaceId: { in: [WS_A, WS_B] } }],
        },
      });
      await db.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
      await db.auditLog.deleteMany({
        where: { userId: { in: [ADMIN, MEMBER] } },
      });
      await db.organizationMember.deleteMany({
        where: { organizationId: ORG },
      });
      await db.user.deleteMany({ where: { id: { in: [ADMIN, MEMBER] } } });
      await db.organization.deleteMany({ where: { id: ORG } });

      await db.organization.create({
        data: { id: ORG, name: ORG, slug: `${P}slug` },
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
      for (const id of [WS_A, WS_B]) {
        await db.workspace.create({
          data: { id, name: id, organizationId: ORG },
        });
      }
      // The member holds an OWNER binding on WS_A: they can use and manage the
      // workspace, but org-wide OAuth credentials still need org admin.
      await db.workspaceAccess.create({
        data: { workspaceId: WS_A, userId: MEMBER, role: "owner" },
      });
    });

    afterAll(async () => {
      await db?.$disconnect();
    });

    const save = (
      path: string,
      user: string,
      clientId: string,
      workspaceId?: string,
    ) =>
      app.request(path, {
        method: "POST",
        headers: session(user, workspaceId),
        body: JSON.stringify({ clientId, clientSecret: `${clientId}-secret` }),
      });

    it("org admin saves on Gmail once → every Google app in every workspace uses it", async () => {
      const res = await save("/v1/org/apps/gmail/config", ADMIN, "org-google");
      expect(res.status).toBe(201);

      const rows = await db.appConfig.findMany({
        where: { organizationId: ORG },
        select: { provider: true, scope: true },
      });
      expect(rows).toEqual([{ provider: "google", scope: "organization" }]);

      for (const ws of [WS_A, WS_B]) {
        for (const appId of [
          "gmail",
          "google-drive",
          "google-calendar",
          "youtube",
        ]) {
          expect(await clientIdFor(ws, appId), `${ws}/${appId}`).toBe(
            "org-google",
          );
        }
      }
      // A different vendor is untouched.
      expect(await clientIdFor(WS_A, "jira")).toBeUndefined();

      // The workspace UI sees Drive as configured, from the org.
      const status = await app.request("/v1/apps/google-drive/config", {
        headers: session(ADMIN, WS_A),
      });
      const body = await status.json();
      expect(status.status, JSON.stringify(body)).toBe(200);
      expect(body).toMatchObject({
        enabled: true,
        hasCredentials: true,
        source: "organization",
      });
    });

    it("workspace admin saves on Drive → overrides Google for that workspace only; removing it falls back to the org", async () => {
      await save("/v1/org/apps/gmail/config", ADMIN, "org-google");

      const res = await save(
        "/v1/apps/google-drive/config",
        ADMIN,
        "ws-a-google",
        WS_A,
      );
      expect(res.status).toBe(201);
      expect(
        await db.appConfig.findMany({
          where: { workspaceId: WS_A },
          select: { provider: true },
        }),
      ).toEqual([{ provider: "google" }]);

      expect(await clientIdFor(WS_A, "google-drive")).toBe("ws-a-google");
      expect(await clientIdFor(WS_A, "gmail")).toBe("ws-a-google");
      expect(await clientIdFor(WS_B, "gmail")).toBe("org-google");

      const del = await app.request("/v1/apps/gmail/config", {
        method: "DELETE",
        headers: session(ADMIN, WS_A),
      });
      expect(del.status).toBe(204);
      expect(await clientIdFor(WS_A, "google-drive")).toBe("org-google");
    });

    it("a member cannot set or remove workspace credentials (403), and nothing is written", async () => {
      const res = await save(
        "/v1/apps/google-drive/config",
        MEMBER,
        "member-google",
        WS_A,
      );
      expect(res.status).toBe(403);
      expect(await db.appConfig.count({ where: { workspaceId: WS_A } })).toBe(
        0,
      );

      // Members can still read status.
      const status = await app.request("/v1/apps/google-drive/config", {
        headers: session(MEMBER, WS_A),
      });
      expect(status.status).toBe(200);
    });

    // Free self-host is a flat team (no role enforcement): there the same
    // gate only fences active membership, so a plain member CAN save. The
    // admin rule above must not lock a self-hoster out of their own setup.
    it("with roles off (flat-team self-host) a member can save workspace credentials", async () => {
      const env = await import("../lib/env.js");
      Object.defineProperty(env.CAPS, "rbac", {
        value: false,
        configurable: true,
      });
      try {
        const res = await save(
          "/v1/apps/google-drive/config",
          MEMBER,
          "member-google",
          WS_A,
        );
        expect(res.status).toBe(201);
        expect(await clientIdFor(WS_A, "gmail")).toBe("member-google");
      } finally {
        Object.defineProperty(env.CAPS, "rbac", {
          value: true,
          configurable: true,
        });
      }
    });

    it("a pre-grouping per-app org row is replaced by the group row on save", async () => {
      await db.appConfig.create({
        data: {
          scope: "organization",
          organizationId: ORG,
          provider: "gmail",
          enabled: true,
          settings: { clientId: "legacy-gmail" },
          credentials: "unused",
        },
      });

      await save("/v1/org/apps/google-docs/config", ADMIN, "org-google");

      const providers = (
        await db.appConfig.findMany({
          where: { organizationId: ORG },
          select: { provider: true },
        })
      ).map((r) => r.provider);
      expect(providers).toEqual(["google"]);
      expect(await clientIdFor(WS_A, "gmail")).toBe("org-google");
    });

    // "Leave empty to keep current": re-saving a pre-grouping per-app config
    // without retyping its secret moves that secret onto the group row.
    it("re-saving a legacy per-app row with the secret left empty keeps its secret", async () => {
      const { getCrypto } = await import("../providers/index.js");
      await db.appConfig.create({
        data: {
          scope: "workspace",
          workspaceId: WS_A,
          provider: "gmail",
          enabled: true,
          settings: { clientId: "legacy-gmail" },
          credentials: await getCrypto().encrypt(
            JSON.stringify({ clientSecret: "legacy-secret" }),
          ),
        },
      });

      const res = await app.request("/v1/apps/gmail/config", {
        method: "POST",
        headers: session(ADMIN, WS_A),
        body: JSON.stringify({ clientId: "renamed-gmail", clientSecret: "" }),
      });
      expect(res.status).toBe(201);

      expect(
        (
          await db.appConfig.findMany({
            where: { workspaceId: WS_A },
            select: { provider: true },
          })
        ).map((r) => r.provider),
      ).toEqual(["google"]);
      const resolved = await resolveAppCredentials(
        WS_A,
        getApp("google-drive")!,
        ORG,
      );
      expect(resolved?.values).toEqual({
        clientId: "renamed-gmail",
        clientSecret: "legacy-secret",
      });
    });

    // ── One redirect URI per vendor ───────────────────────────────────────

    /**
     * Stub ONLY the vendor's outbound endpoints (Google token + userinfo) and
     * record the redirect_uri Google would receive at token exchange.
     */
    const stubGoogle = () => {
      const seen: { tokenRedirectUri?: string; clientId?: string } = {};
      const realFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.startsWith("https://oauth2.googleapis.com/token")) {
            const body = new URLSearchParams(String(init?.body));
            seen.tokenRedirectUri = body.get("redirect_uri") ?? undefined;
            seen.clientId = body.get("client_id") ?? undefined;
            return Response.json({
              access_token: "at",
              refresh_token: "rt",
              expires_in: 3600,
              scope: "openid email",
            });
          }
          if (url.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) {
            return Response.json({ email: "dana@example.com", name: "Dana" });
          }
          return realFetch(input, init);
        }),
      );
      return seen;
    };

    afterEach(() => vi.unstubAllGlobals());

    const authorize = async (appId: string) => {
      const res = await app.request(
        `http://api.test/v1/apps/${appId}/authorize`,
        { headers: session(ADMIN, WS_A) },
      );
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      const redirectUri = location.searchParams.get("redirect_uri")!;
      return {
        redirectUri,
        // The origin is the configured API_URL (env-dependent); the path is
        // what the vendor app must have registered.
        redirectPath: new URL(redirectUri).pathname,
        state: location.searchParams.get("state")!,
        clientId: location.searchParams.get("client_id")!,
        scopes: (location.searchParams.get("scope") ?? "").split(" "),
      };
    };

    it("org Google client: Gmail and Drive both use ONE vendor redirect URI, end to end", async () => {
      await save("/v1/org/apps/gmail/config", ADMIN, "org-google");

      const gmail = await authorize("gmail");
      const drive = await authorize("google-drive");
      expect(gmail.redirectPath).toBe("/v1/apps/oauth/google/callback");
      expect(drive.redirectUri).toBe(gmail.redirectUri);
      expect(gmail.clientId).toBe("org-google");

      // Google sends the browser back to the vendor URI; the connection lands
      // on the app from the signed state (Drive), minted by the org client.
      const seen = stubGoogle();
      const cb = await app.request(
        `http://api.test/v1/apps/oauth/google/callback?code=c&state=${encodeURIComponent(drive.state)}`,
      );
      expect(cb.status).toBe(302);
      expect(cb.headers.get("location")).toContain("status=success");
      expect(seen.tokenRedirectUri).toBe(drive.redirectUri);
      expect(seen.clientId).toBe("org-google");

      const conn = await db.appConnection.findFirst({
        where: { workspaceId: WS_A },
        select: { provider: true, appConfig: { select: { provider: true } } },
      });
      expect(conn).toEqual({
        provider: "google-drive",
        appConfig: { provider: "google" },
      });
    });

    it("platform (env) client keeps the per-app redirect URI (no change for existing setups)", async () => {
      vi.stubEnv("GOOGLE_CLIENT_ID", "platform-google");
      vi.stubEnv("GOOGLE_CLIENT_SECRET", "platform-secret");
      try {
        const gmail = await authorize("gmail");
        expect(gmail.redirectPath).toBe("/v1/apps/gmail/callback");
        expect(gmail.clientId).toBe("platform-google");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("a state cannot be completed on the other route, or under another vendor", async () => {
      await save("/v1/org/apps/gmail/config", ADMIN, "org-google");
      const drive = await authorize("google-drive");
      const seen = stubGoogle();

      // Vendor-path state replayed on the per-app path.
      const perApp = await app.request(
        `http://api.test/v1/apps/google-drive/callback?code=c&state=${encodeURIComponent(drive.state)}`,
      );
      expect(perApp.headers.get("location")).toContain("status=error");

      // Google state replayed under the Atlassian vendor path.
      const wrongVendor = await app.request(
        `http://api.test/v1/apps/oauth/atlassian/callback?code=c&state=${encodeURIComponent(drive.state)}`,
      );
      expect(wrongVendor.headers.get("location")).toContain("status=error");
      // Lands on a real app page that renders the error (not a 404).
      expect(wrongVendor.headers.get("location")).toContain(
        "/app-connect/google-drive?",
      );
      const noState = await app.request(
        "http://api.test/v1/apps/oauth/atlassian/callback?code=c",
      );
      expect(noState.headers.get("location")).toMatch(
        /\/app-connect\/(jira|confluence)\?status=error/,
      );

      expect(seen.tokenRedirectUri).toBeUndefined();
      expect(
        await db.appConnection.count({ where: { workspaceId: WS_A } }),
      ).toBe(0);

      // A path that names no vendor is not an OAuth callback at all.
      const unknown = await app.request(
        `http://api.test/v1/apps/oauth/nope/callback?code=c&state=${encodeURIComponent(drive.state)}`,
      );
      expect(unknown.status).toBe(404);
    });

    // One Atlassian 3LO app = one consent per user, and a new consent replaces
    // the old one's scopes. Through the shared client, Jira and Confluence
    // both ask for the union, so connecting one never strips the other.
    it("shared Atlassian client: Jira and Confluence request the same, combined scopes", async () => {
      await save("/v1/apps/jira/config", ADMIN, "ws-a-atlassian", WS_A);
      const jira = await authorize("jira");
      const confluence = await authorize("confluence");
      expect(jira.redirectPath).toBe("/v1/apps/oauth/atlassian/callback");
      expect(confluence.redirectUri).toBe(jira.redirectUri);
      expect(new Set(jira.scopes)).toEqual(new Set(confluence.scopes));
      expect(jira.scopes).toEqual(
        expect.arrayContaining(["read:jira-work", "read:page:confluence"]),
      );
    });

    it("org-scoped connect (Org › Global connections) also uses the vendor URI end to end", async () => {
      await save("/v1/org/apps/gmail/config", ADMIN, "org-google");
      const res = await app.request(
        `http://api.test/v1/org/apps/google-calendar/authorize`,
        { headers: session(ADMIN) },
      );
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      const redirectUri = location.searchParams.get("redirect_uri")!;
      expect(new URL(redirectUri).pathname).toBe(
        "/v1/apps/oauth/google/callback",
      );

      const seen = stubGoogle();
      const cb = await app.request(
        `http://api.test/v1/apps/oauth/google/callback?code=c&state=${encodeURIComponent(location.searchParams.get("state")!)}`,
      );
      expect(cb.headers.get("location")).toContain("status=success");
      expect(seen.tokenRedirectUri).toBe(redirectUri);
      expect(
        await db.appConnection.findFirst({
          where: { organizationId: ORG, scope: "organization" },
          select: { provider: true },
        }),
      ).toEqual({ provider: "google-calendar" });
    });

    // ── Backward compat: platform-minted accounts on org vendor save ──────

    it("org Google save sweeps platform-minted Google accounts (they can't refresh with the org client), but not overridden workspaces or other vendors", async () => {
      const mk = (workspaceId: string, provider: string) =>
        db.appConnection.create({
          data: {
            workspaceId,
            provider,
            scope: "workspace",
            status: "connected",
            credentials: "x",
          },
          select: { id: true },
        });
      const aDrive = await mk(WS_A, "google-drive");
      const aJira = await mk(WS_A, "jira");
      const bGmail = await mk(WS_B, "gmail");
      // WS_B has its own Google client: its accounts keep refreshing with it.
      await save("/v1/apps/google-docs/config", ADMIN, "ws-b-google", WS_B);
      const bGmail2 = await mk(WS_B, "gmail");

      // The confirm dialog's count includes the account that save will drop.
      const status = await app.request("/v1/org/apps/gmail/config", {
        headers: session(ADMIN),
      });
      expect(
        (
          (await status.json()) as {
            dependents: { workspaceConnections: number };
          }
        ).dependents.workspaceConnections,
      ).toBe(1);

      await save("/v1/org/apps/gmail/config", ADMIN, "org-google");

      const left = (
        await db.appConnection.findMany({
          where: { workspaceId: { in: [WS_A, WS_B] } },
          select: { id: true },
        })
      ).map((c) => c.id);
      expect(left).not.toContain(aDrive.id);
      expect(left).toContain(aJira.id);
      expect(left).toContain(bGmail2.id);
      // (bGmail was swept by WS_B's own override save, as before.)
      expect(left).not.toContain(bGmail.id);
    });

    // Only a USABLE workspace client keeps refreshing its accounts. A row that
    // is enabled but has no secret resolves nothing (the resolver skips it),
    // so the org client takes those accounts over and they must be swept too.
    it("org Google save also sweeps accounts in a workspace whose own Google row has no secret", async () => {
      await db.appConfig.create({
        data: {
          scope: "workspace",
          workspaceId: WS_A,
          provider: "google",
          enabled: true,
          settings: { clientId: "half-saved" },
          credentials: null,
        },
      });
      const aGmail = await db.appConnection.create({
        data: {
          workspaceId: WS_A,
          provider: "gmail",
          scope: "workspace",
          status: "connected",
          credentials: "x",
        },
        select: { id: true },
      });

      await save("/v1/org/apps/gmail/config", ADMIN, "org-google");

      expect(
        await db.appConnection.findUnique({ where: { id: aGmail.id } }),
      ).toBeNull();
      expect(await clientIdFor(WS_A, "gmail")).toBe("org-google");
    });

    // ── Tenancy: another org's rows are never read or swept ───────────────

    it("an org's Google client never reaches, or sweeps, another org's workspaces", async () => {
      const FOREIGN_ORG = `${P}foreign-org`;
      const FOREIGN_WS = `${P}foreign-ws`;
      const cleanup = async () => {
        await db.appConnection.deleteMany({
          where: { workspaceId: FOREIGN_WS },
        });
        await db.appConfig.deleteMany({
          where: {
            OR: [{ organizationId: FOREIGN_ORG }, { workspaceId: FOREIGN_WS }],
          },
        });
        await db.workspace.deleteMany({ where: { id: FOREIGN_WS } });
        await db.organization.deleteMany({ where: { id: FOREIGN_ORG } });
      };
      await cleanup();
      try {
        await db.organization.create({
          data: { id: FOREIGN_ORG, name: FOREIGN_ORG, slug: `${P}foreign` },
        });
        await db.workspace.create({
          data: {
            id: FOREIGN_WS,
            name: FOREIGN_WS,
            organizationId: FOREIGN_ORG,
          },
        });
        const foreignConn = await db.appConnection.create({
          data: {
            workspaceId: FOREIGN_WS,
            provider: "gmail",
            scope: "workspace",
            status: "connected",
            credentials: "x",
          },
          select: { id: true },
        });

        expect(
          (await save("/v1/org/apps/gmail/config", ADMIN, "org-google")).status,
        ).toBe(201);

        // The foreign org's platform-minted account is untouched…
        expect(
          await db.appConnection.findUnique({ where: { id: foreignConn.id } }),
        ).not.toBeNull();
        // …and its workspace does not resolve our org's client.
        expect(
          (
            await resolveAppCredentials(
              FOREIGN_WS,
              getApp("gmail")!,
              FOREIGN_ORG,
            )
          )?.values.clientId,
        ).toBeUndefined();
        // Positive control: our own workspaces do.
        expect(await clientIdFor(WS_A, "google-drive")).toBe("org-google");
      } finally {
        await cleanup();
      }
    });
  },
);
