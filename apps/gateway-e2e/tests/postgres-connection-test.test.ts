import { createServer, type Socket } from "node:net";

import { createOnpremAuth } from "@onecli/api/lib/better-auth";
import { cryptoService } from "@onecli/api/lib/crypto";
import { hashPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { e2eConfig } from "../src/env.js";
import {
  psql,
  startPostgresTarget,
  TARGET_ROLES,
  type PostgresTarget,
} from "../src/postgres.js";
import { scenario } from "../src/scenario.js";

let target: PostgresTarget | undefined;
beforeAll(async () => {
  if (e2eConfig() !== null) target = await startPostgresTarget();
}, 120_000);
afterAll(async () => {
  await target?.stop();
});

const connection = (superuser = false) => ({
  provider: "postgres",
  credentials: {
    host: "127.0.0.1",
    port: String(target?.port ?? 0),
    database: "postgres",
    ...(superuser
      ? { username: "postgres", password: "postgres" }
      : TARGET_ROLES.scram),
    sslmode: "require",
  },
});
const gateway = { env: { GATEWAY_ALLOW_PRIVATE_DESTINATIONS: "127.0.0.1" } };
const post = (
  origin: string,
  id: string,
  token: string,
  workspace?: string,
  organization?: string,
) =>
  fetch(`${origin}/v1/connections/${id}/test`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(workspace ? { "x-workspace-id": workspace } : {}),
      ...(organization ? { "x-organization-id": organization } : {}),
    },
  });

describe("stored PostgreSQL connection checks", () => {
  for (const superuser of [false, true]) {
    scenario(
      `logs in to real PostgreSQL and audits superuser=${String(superuser)}`,
      async (cx) => {
        await cx.seed({
          withApiKey: true,
          appConnections: [connection(superuser)],
        });
        const gw = await cx.startGateway(gateway);
        const id = `${cx.ids.workspace}-conn-0`;
        const response = await post(gw.origin, id, cx.ids.apiKey);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, superuser });
        expect(
          (
            await cx.db.prisma.appConnection.findUniqueOrThrow({
              where: { id },
            })
          ).metadata,
        ).toMatchObject({ superuser });
        const audit = await cx.db.prisma.auditLog.findMany({
          where: { service: "app-connection", userId: cx.ids.user },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]?.metadata).toEqual({ connectionId: id, superuser });
        expect((await post(gw.origin, id, cx.ids.apiKey)).status).toBe(200);
        expect(
          await cx.db.prisma.auditLog.count({
            where: { service: "app-connection" },
          }),
        ).toBe(1);
      },
    );
  }

  scenario(
    "rejects anonymous and agent principals without disclosing credentials",
    async (cx) => {
      await cx.seed({ withApiKey: true, appConnections: [connection()] });
      const gw = await cx.startGateway(gateway);
      const id = `${cx.ids.workspace}-conn-0`;
      for (const token of [
        "",
        "oc_invalid",
        cx.ids.agentToken,
        "rnr_invalid",
      ]) {
        const response = await post(gw.origin, id, token);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication and a valid scope are required.",
            details: [],
          },
        });
      }
    },
  );

  scenario(
    "hides foreign workspace, foreign org and org scope from a workspace key",
    async (cx) => {
      await cx.seed({
        withApiKey: true,
        withOrgApiKey: true,
        appConnections: [connection()],
      });
      const gw = await cx.startGateway(gateway);
      const id = `${cx.ids.workspace}-conn-0`;
      const other = `${cx.ids.workspace}-other`;
      await cx.db.prisma.workspace.create({
        data: { id: other, name: other, organizationId: cx.ids.org },
      });
      await cx.db.prisma.appConnection.update({
        where: { id },
        data: { workspaceId: other },
      });
      expect((await post(gw.origin, id, cx.ids.apiKey)).status).toBe(404);
      await cx.db.prisma.appConnection.update({
        where: { id },
        data: {
          scope: "organization",
          workspaceId: null,
          organizationId: cx.ids.org,
        },
      });
      expect((await post(gw.origin, id, cx.ids.apiKey)).status).toBe(404);
      const foreign = `${cx.ids.org}-foreign`;
      await cx.db.prisma.organization.create({
        data: { id: foreign, name: foreign, slug: foreign },
      });
      await cx.db.prisma.appConnection.update({
        where: { id },
        data: { organizationId: foreign },
      });
      expect(
        (await post(gw.origin, id, cx.ids.orgApiKey, undefined, cx.ids.org))
          .status,
      ).toBe(404);
      expect(
        await cx.db.prisma.auditLog.count({
          where: { service: "app-connection" },
        }),
      ).toBe(0);
    },
  );

  scenario(
    "works on unlicensed onprem while preserving the membership fence",
    async (cx) => {
      await cx.seed({ withApiKey: true, appConnections: [connection()] });
      await cx.db.prisma.organizationMember.updateMany({
        where: { userId: cx.ids.user },
        data: { role: "member" },
      });
      const gw = await cx.startGateway({
        env: { ...gateway.env, ENTERPRISE_ENABLED: "false", REDIS_HOST: "" },
      });
      const id = `${cx.ids.workspace}-conn-0`;
      const success = await post(gw.origin, id, cx.ids.apiKey);
      expect(success.status).toBe(200);
      expect(await success.json()).toEqual({ ok: true, superuser: false });
      await cx.db.prisma.organizationMember.updateMany({
        where: { userId: cx.ids.user },
        data: { status: "suspended" },
      });
      expect((await post(gw.origin, id, cx.ids.apiKey)).status).toBe(401);
    },
  );

  scenario(
    "applies the destination guard to stored private addresses",
    async (cx) => {
      await cx.seed({ withApiKey: true, appConnections: [connection()] });
      const gw = await cx.startGateway({
        env: { GATEWAY_ALLOW_PRIVATE_DESTINATIONS: "" },
      });
      const response = await post(
        gw.origin,
        `${cx.ids.workspace}-conn-0`,
        cx.ids.apiKey,
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        // The guard's own code: a private address is a fix the user can
        // make, not a generic failure.
        error: { code: "PRIVATE_DESTINATION", details: [] },
      });
      expect(
        await cx.db.prisma.auditLog.count({
          where: { service: "app-connection" },
        }),
      ).toBe(0);
    },
  );

  scenario(
    "returns safe bad-credential errors and limits repeated attempts",
    async (cx) => {
      const stored = connection();
      stored.credentials.password = "never-return-this-password";
      await cx.seed({ withApiKey: true, appConnections: [stored] });
      const gw = await cx.startGateway(gateway);
      const id = `${cx.ids.workspace}-conn-0`;
      for (let n = 0; n < 5; n += 1) {
        const response = await post(gw.origin, id, cx.ids.apiKey);
        expect(response.status).toBe(422);
        const body = await response.text();
        expect(body).toContain('"code":"LOGIN_REJECTED"');
        expect(body).not.toContain(stored.credentials.password);
        expect(body).not.toContain("password authentication failed");
      }
      const limited = await post(gw.origin, id, cx.ids.apiKey);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({
        error: { code: "RATE_LIMITED", details: [] },
      });
      expect(
        await cx.db.prisma.auditLog.count({
          where: { service: "app-connection" },
        }),
      ).toBe(0);
      expect(gw.logs()).not.toContain(stored.credentials.password);
    },
  );

  scenario(
    "bounds a stalled TLS login and leaves metadata unchanged",
    async (cx) => {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("missing TCP address");
        const stored = connection();
        stored.credentials.port = String(address.port);
        await cx.seed({ withApiKey: true, appConnections: [stored] });
        const gw = await cx.startGateway(gateway);
        const id = `${cx.ids.workspace}-conn-0`;
        const started = Date.now();
        const response = await post(gw.origin, id, cx.ids.apiKey);
        expect(response.status).toBe(504);
        expect(await response.json()).toMatchObject({
          error: { code: "TEST_TIMEOUT", details: [] },
        });
        expect(Date.now() - started).toBeLessThan(20_000);
        expect(
          (
            await cx.db.prisma.appConnection.findUniqueOrThrow({
              where: { id },
            })
          ).metadata ?? {},
        ).not.toHaveProperty("superuser");
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  scenario(
    "checks browser org membership and role without a default workspace",
    async (cx) => {
      await cx.seed({
        withApiKey: true,
        appConnections: [{ ...connection(), scope: "organization" }],
      });
      const secret =
        "e2e-connection-cookie-secret-e2e-connection-cookie-secret";
      const auth = createOnpremAuth({
        prisma: cx.db.prisma,
        secret,
        baseURL: "http://127.0.0.1:10256",
      });
      const user = await cx.db.prisma.user.findUniqueOrThrow({
        where: { id: cx.ids.user },
      });
      const password = "e2e-signin-password";
      await cx.db.prisma.account.create({
        data: {
          userId: user.id,
          accountId: user.id,
          providerId: "credential",
          password: await hashPassword(password),
        },
      });
      const signedIn = await auth.api.signInEmail({
        body: { email: user.email, password },
        asResponse: true,
      });
      expect(signedIn.status).toBe(200);
      const cookie = signedIn.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const gw = await cx.startGateway({
        env: { ...gateway.env, BETTER_AUTH_SECRET: secret },
      });
      const id = `${cx.ids.workspace}-conn-0`;
      const browserPost = (org: string) =>
        fetch(`${gw.origin}/v1/connections/${id}/test`, {
          method: "POST",
          headers: { cookie, "x-organization-id": org },
        });
      const success = await browserPost(cx.ids.org);
      expect(success.status).toBe(200);
      expect(await success.json()).toEqual({ ok: true, superuser: false });
      expect((await browserPost(`${cx.ids.org}-foreign`)).status).toBe(404);
      await cx.db.prisma.organizationMember.updateMany({
        where: { userId: user.id },
        data: { role: "member" },
      });
      expect((await browserPost(cx.ids.org)).status).toBe(403);
      await cx.db.prisma.organizationMember.updateMany({
        where: { userId: user.id },
        data: { status: "suspended" },
      });
      expect((await browserPost(cx.ids.org)).status).toBe(404);
    },
  );

  scenario("requires unambiguous explicit organization scope", async (cx) => {
    await cx.seed({
      withApiKey: true,
      withOrgApiKey: true,
      appConnections: [{ ...connection(), scope: "organization" }],
    });
    const gw = await cx.startGateway(gateway);
    const id = `${cx.ids.workspace}-conn-0`;
    expect((await post(gw.origin, id, cx.ids.orgApiKey)).status).toBe(401);
    expect(
      (await post(gw.origin, id, cx.ids.orgApiKey, cx.ids.workspace)).status,
    ).toBe(404);
    expect(
      (await post(gw.origin, id, cx.ids.apiKey, undefined, cx.ids.org)).status,
    ).toBe(404);
    const ambiguous = await post(
      gw.origin,
      id,
      cx.ids.orgApiKey,
      cx.ids.workspace,
      cx.ids.org,
    );
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toMatchObject({
      error: { code: "INVALID_SCOPE", details: [] },
    });
    expect(
      (
        await post(
          gw.origin,
          id,
          cx.ids.orgApiKey,
          undefined,
          `${cx.ids.org}-foreign`,
        )
      ).status,
    ).toBe(404);
  });

  scenario(
    "tests organization connections with an org-scoped key",
    async (cx) => {
      await cx.seed({
        withOrgApiKey: true,
        appConnections: [{ ...connection(), scope: "organization" }],
      });
      const gw = await cx.startGateway(gateway);
      const id = `${cx.ids.workspace}-conn-0`;
      const response = await post(
        gw.origin,
        id,
        cx.ids.orgApiKey,
        undefined,
        cx.ids.org,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, superuser: false });
      const audit = await cx.db.prisma.auditLog.findFirstOrThrow({
        where: { service: "app-connection" },
      });
      expect(audit.workspaceId).toBeNull();
      expect(audit.organizationId).toBe(cx.ids.org);
    },
  );

  scenario(
    "bounds concurrent checks globally across different users",
    async (cx) => {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const pending: Array<Promise<Response>> = [];
      try {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("missing TCP address");
        const stored = connection();
        stored.credentials.port = String(address.port);
        await cx.seed({ withApiKey: true, appConnections: [stored] });
        const gw = await cx.startGateway(gateway);
        const id = `${cx.ids.workspace}-conn-0`;
        for (let n = 0; n < 8; n += 1) {
          const userId = `${cx.ids.user}-${String(n)}`;
          const email = `${userId}@e2e.invalid`;
          const key = `${cx.ids.apiKey}-${String(n)}`;
          await cx.db.prisma.user.create({
            data: { id: userId, email, externalAuthId: userId },
          });
          await cx.db.prisma.organizationMember.create({
            data: {
              organizationId: cx.ids.org,
              userId,
              userEmail: email,
              role: "owner",
            },
          });
          await cx.db.prisma.apiKey.create({
            data: {
              key,
              scope: "workspace",
              workspaceId: cx.ids.workspace,
              userId,
              userEmail: email,
            },
          });
          pending.push(post(gw.origin, id, key));
        }
        await expect.poll(() => sockets.size, { timeout: 5_000 }).toBe(8);
        const limited = await post(gw.origin, id, cx.ids.apiKey);
        expect(limited.status).toBe(429);
        expect(await limited.json()).toMatchObject({
          error: { code: "RATE_LIMITED", details: [] },
        });
      } finally {
        for (const socket of sockets) socket.destroy();
        await Promise.all(pending);
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  for (const scope of ["workspace", "organization"] as const) {
    scenario(
      `cached ${scope} front-door login cannot stamp rotated credentials`,
      async (cx) => {
        await cx.seed({
          appConnections: [{ ...connection(true), scope }],
          grantAll: true,
          rules: [
            {
              name: "allow-db",
              action: "allow",
              targets: [{ kind: "connection", connectionIndex: 0 }],
            },
          ],
        });
        const gw = await cx.startGateway(gateway);
        const id = `${cx.ids.workspace}-conn-0`;
        const first = await psql(gw.port, id, cx.ids.agentToken, ["SELECT 1"]);
        expect(first.stdout.trim()).toBe("1");
        expect(
          (
            await cx.db.prisma.appConnection.findUniqueOrThrow({
              where: { id },
            })
          ).metadata,
        ).toMatchObject({ superuser: true });
        await cx.db.prisma.appConnection.update({
          where: { id },
          data: {
            credentials: await cryptoService.encrypt(
              JSON.stringify({
                ...connection(true).credentials,
                password: "rotated-login",
              }),
            ),
            metadata: {},
          },
        });
        // No cache invalidation: the second gateway login succeeds using its
        // authorized old ciphertext, but cannot mark the replacement credential.
        const cached = await psql(gw.port, id, cx.ids.agentToken, ["SELECT 2"]);
        expect(cached.stdout.trim()).toBe("2");
        expect(
          (
            await cx.db.prisma.appConnection.findUniqueOrThrow({
              where: { id },
            })
          ).metadata,
        ).toEqual({});
      },
    );
  }

  scenario(
    "cached front-door login cannot stamp a connection moved to another tenant",
    async (cx) => {
      await cx.seed({
        appConnections: [connection(true)],
        grantAll: true,
        rules: [
          {
            name: "allow-db",
            action: "allow",
            targets: [{ kind: "connection", connectionIndex: 0 }],
          },
        ],
      });
      const gw = await cx.startGateway(gateway);
      const id = `${cx.ids.workspace}-conn-0`;
      expect(
        (
          await psql(gw.port, id, cx.ids.agentToken, ["SELECT 1"])
        ).stdout.trim(),
      ).toBe("1");
      const foreignOrg = `${cx.ids.org}-foreign`;
      const foreignWorkspace = `${cx.ids.workspace}-foreign`;
      await cx.db.prisma.organization.create({
        data: { id: foreignOrg, name: foreignOrg, slug: foreignOrg },
      });
      await cx.db.prisma.workspace.create({
        data: {
          id: foreignWorkspace,
          name: foreignWorkspace,
          organizationId: foreignOrg,
        },
      });
      await cx.db.prisma.appConnection.update({
        where: { id },
        data: {
          workspaceId: foreignWorkspace,
          organizationId: foreignOrg,
          metadata: {},
        },
      });
      expect(
        (
          await psql(gw.port, id, cx.ids.agentToken, ["SELECT 2"])
        ).stdout.trim(),
      ).toBe("2");
      expect(
        (await cx.db.prisma.appConnection.findUniqueOrThrow({ where: { id } }))
          .metadata,
      ).toEqual({});
    },
  );

  scenario(
    "does not write stale role metadata after concurrent reconnect",
    async (cx) => {
      // Hold the metadata write with a row lock, then replace the encrypted
      // credentials before releasing it. The old check must not bless the new login.
      await cx.seed({ withApiKey: true, appConnections: [connection()] });
      const gw = await cx.startGateway(gateway);
      const id = `${cx.ids.workspace}-conn-0`;
      let response: Promise<Response> | undefined;
      await cx.db.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM app_connections WHERE id = ${id} FOR UPDATE`;
        response = post(gw.origin, id, cx.ids.apiKey);
        await expect
          .poll(
            async () => {
              const waiting = await cx.db.prisma.$queryRaw<
                Array<{ count: bigint }>
              >`
            SELECT count(*) AS count FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%WITH updated AS%'
          `;
              return Number(waiting[0]?.count ?? 0);
            },
            { timeout: 3_000, interval: 50 },
          )
          .toBe(1);
        await tx.appConnection.update({
          where: { id },
          data: {
            credentials: await cryptoService.encrypt(
              JSON.stringify({
                ...connection().credentials,
                password: "rotated",
              }),
            ),
          },
        });
      });
      expect((await response)?.status).toBe(200);
      expect(
        (await cx.db.prisma.appConnection.findUniqueOrThrow({ where: { id } }))
          .metadata ?? {},
      ).not.toHaveProperty("superuser");
      expect(
        await cx.db.prisma.auditLog.count({
          where: { service: "app-connection" },
        }),
      ).toBe(0);
    },
  );
});
