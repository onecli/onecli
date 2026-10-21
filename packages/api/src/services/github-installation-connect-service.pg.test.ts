import { randomBytes, generateKeyPairSync } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { proofDatabaseUrl, waitForLockWaiters } from "../testing/pg-proof";

const homes = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./home-sync-service", () => ({ bumpHomeForScope: homes }));
const url = proofDatabaseUrl();
let db: typeof import("@onecli/db").db;
let service: typeof import("./github-installation-connect-service");
let connections: typeof import("./connection-service");
let crypto: ReturnType<typeof import("../providers").getCrypto>;
const prefix = "github-installation-connect-proof";
const org = `${prefix}-org`;
const foreignOrg = `${prefix}-foreign`;
const ws = `${prefix}-ws`;
const ws2 = `${prefix}-ws2`;
const foreignWs = `${prefix}-foreign-ws`;
const scope = { workspaceId: ws };
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const credentials = {
  type: "github_app",
  app_id: "123",
  installation_id: "456",
  private_key: privateKey,
  access_token: "original",
};
const options = { metadata: { installationId: "456", username: "acme" } };
const input = () => ({
  scope,
  organizationId: org,
  credentials: { ...credentials },
  options,
});
const rows = () =>
  db.appConnection.findMany({
    where: {
      OR: [{ organizationId: org }, { workspace: { organizationId: org } }],
    },
  });
const seed = (target = scope, grant = credentials) =>
  connections.createConnection(target, "github-app", grant, options);

beforeAll(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
  ({ db } = await import("@onecli/db"));
  (await import("../edition-defaults")).ensureEditionDefaults();
  crypto = (await import("../providers")).getCrypto();
  connections = await import("./connection-service");
  service = await import("./github-installation-connect-service");
  await db.organization.createMany({
    data: [org, foreignOrg].map((id) => ({ id, name: id, slug: id })),
    skipDuplicates: true,
  });
  await db.workspace.createMany({
    data: [
      { id: ws, name: ws, organizationId: org },
      { id: ws2, name: ws2, organizationId: org },
      { id: foreignWs, name: foreignWs, organizationId: foreignOrg },
    ],
    skipDuplicates: true,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  homes.mockClear();
  if (url)
    await db.appConnection.deleteMany({
      where: {
        OR: [
          { organizationId: { in: [org, foreignOrg] } },
          { workspaceId: { in: [ws, ws2, foreignWs] } },
        ],
      },
    });
});
afterAll(async () => {
  if (!url) return;
  await db.workspace.deleteMany({
    where: { id: { in: [ws, ws2, foreignWs] } },
  });
  await db.organization.deleteMany({
    where: { id: { in: [org, foreignOrg] } },
  });
  await db.$disconnect();
});

const deferred = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

describe.skipIf(!url)(
  "atomic GitHub installation OAuth persistence on PostgreSQL",
  () => {
    it("creates once, runs the create hook once, and reconnects the same scope by installation rather than label", async () => {
      const hook = vi.fn(async () => {});
      const first = await service.connectGitHubInstallation({
        ...input(),
        beforeCreate: hook,
      });
      expect(first.status).toBe("created");
      const second = await service.connectGitHubInstallation({
        ...input(),
        beforeCreate: hook,
        options: { metadata: { ...options.metadata, username: "renamed" } },
      });
      expect(second.status).toBe("reconnected");
      expect(second).toMatchObject({
        connection:
          first.status !== "updated" ? { id: first.connection.id } : null,
      });
      expect(hook).toHaveBeenCalledTimes(1);
      expect(await rows()).toHaveLength(1);
      expect(homes).toHaveBeenCalledTimes(2);
    });

    it("returns updated without mutation or create-hook side effects when another workspace owns the installation", async () => {
      await seed({ workspaceId: ws2 });
      const before = await rows();
      homes.mockClear();
      const hook = vi.fn(async () => {});
      expect(
        await service.connectGitHubInstallation({
          ...input(),
          beforeCreate: hook,
        }),
      ).toEqual({ status: "updated" });
      expect(await rows()).toEqual(before);
      expect(hook).not.toHaveBeenCalled();
      expect(homes).not.toHaveBeenCalled();
    });

    it("returns updated for an org installation without mutating it from a workspace", async () => {
      await connections.createConnection(
        { organizationId: org },
        "github-app",
        credentials,
        options,
      );
      const before = await rows();
      expect(await service.connectGitHubInstallation(input())).toEqual({
        status: "updated",
      });
      expect(await rows()).toEqual(before);
    });

    it("promotes and reconnects atomically only for an authorized organization caller", async () => {
      const original = await seed();
      const before = await rows();
      const request = { ...input(), scope: { organizationId: org } };
      await expect(
        service.connectGitHubInstallation(request),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await rows()).toEqual(before);
      const result = await service.connectGitHubInstallation({
        ...request,
        allowPromotion: true,
      });
      expect(result).toEqual({
        status: "reconnected",
        promoted: true,
        connection: expect.objectContaining({ id: original.id }),
      });
      expect(await rows()).toMatchObject([
        {
          id: original.id,
          workspaceId: null,
          organizationId: org,
          scope: "organization",
        },
      ]);
    });

    it("rolls back a promotion if reconnect persistence fails", async () => {
      await seed();
      const before = await rows();
      vi.spyOn(crypto, "encrypt").mockRejectedValueOnce(
        new Error("encryption unavailable"),
      );
      await expect(
        service.connectGitHubInstallation({
          ...input(),
          scope: { organizationId: org },
          allowPromotion: true,
        }),
      ).rejects.toThrow("encryption unavailable");
      expect(await rows()).toEqual(before);
    });

    it.each(["app_id", "installation_id"] as const)(
      "refuses an explicit reconnect that changes %s",
      async (field) => {
        const original = await seed();
        const before = await rows();
        await expect(
          service.connectGitHubInstallation({
            ...input(),
            reconnectId: original.id,
            credentials: { ...credentials, [field]: "999" },
            options: {
              metadata: {
                installationId: field === "installation_id" ? "999" : "456",
              },
            },
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await rows()).toEqual(before);
      },
    );

    it("does not permit explicit reconnect to bypass a connected installation in another scope", async () => {
      const old = await seed();
      await db.appConnection.update({
        where: { id: old.id },
        data: { status: "disconnected" },
      });
      await seed({ workspaceId: ws2 });
      const before = await rows();
      expect(
        await service.connectGitHubInstallation({
          ...input(),
          reconnectId: old.id,
        }),
      ).toEqual({ status: "updated" });
      expect(await rows()).toEqual(before);
    });

    it("fences workspace organization and reconnect identity at query level", async () => {
      const foreign = await seed({ workspaceId: foreignWs });
      await expect(
        service.connectGitHubInstallation({
          ...input(),
          reconnectId: foreign.id,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        service.connectGitHubInstallation({
          ...input(),
          scope: { workspaceId: foreignWs },
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await rows()).toEqual([]);
      // Same external installation in another tenant is not a dedupe candidate.
      expect((await service.connectGitHubInstallation(input())).status).toBe(
        "created",
      );
    });

    it("runs the connection cap hook inside the locked create path and rolls back on refusal", async () => {
      await expect(
        service.connectGitHubInstallation({
          ...input(),
          beforeCreate: async () => {
            throw new Error("connection cap");
          },
        }),
      ).rejects.toThrow("connection cap");
      expect(await rows()).toEqual([]);
      expect(homes).not.toHaveBeenCalled();
    });

    it("serializes concurrent first callbacks, with a checked lock waiter and fresh post-lock reads", async () => {
      const entered = deferred();
      const hold = deferred();
      const first = service.connectGitHubInstallation({
        ...input(),
        beforeCreate: async () => {
          entered.release();
          await hold.promise;
        },
      });
      await entered.promise;
      const second = service.connectGitHubInstallation({
        ...input(),
        scope: { workspaceId: ws2 },
      });
      try {
        await waitForLockWaiters(db, { queryLike: "%pg_advisory_xact_lock%" });
      } finally {
        hold.release();
      }
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.status)).toEqual([
        "created",
        "updated",
      ]);
      expect(await rows()).toMatchObject([{ workspaceId: ws }]);
    });

    it("serializes a concurrent org connect behind workspace creation then promotes the sole row", async () => {
      const entered = deferred();
      const hold = deferred();
      const first = service.connectGitHubInstallation({
        ...input(),
        beforeCreate: async () => {
          entered.release();
          await hold.promise;
        },
      });
      await entered.promise;
      const second = service.connectGitHubInstallation({
        ...input(),
        scope: { organizationId: org },
        allowPromotion: true,
      });
      try {
        await waitForLockWaiters(db, { queryLike: "%pg_advisory_xact_lock%" });
      } finally {
        hold.release();
      }
      expect((await first).status).toBe("created");
      expect((await second).status).toBe("reconnected");
      expect(await rows()).toMatchObject([
        { scope: "organization", organizationId: org, workspaceId: null },
      ]);
    });

    it("never merges different installations just because the account label matches", async () => {
      await seed();
      const result = await service.connectGitHubInstallation({
        ...input(),
        credentials: { ...credentials, installation_id: "789" },
        options: { metadata: { ...options.metadata, installationId: "789" } },
      });
      expect(result.status).toBe("created");
      expect(await rows()).toHaveLength(2);
    });

    it.each(["0456", "0", "456x"])(
      "rejects a noncanonical installation identity %s before storing anything",
      async (installationId) => {
        await expect(
          service.connectGitHubInstallation({
            ...input(),
            credentials: { ...credentials, installation_id: installationId },
            options: { metadata: { installationId } },
          }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(await rows()).toEqual([]);
      },
    );

    it("serializes same-workspace callbacks into one create and one reconnect", async () => {
      const entered = deferred();
      const hold = deferred();
      const first = service.connectGitHubInstallation({
        ...input(),
        beforeCreate: async () => {
          entered.release();
          await hold.promise;
        },
      });
      await entered.promise;
      const second = service.connectGitHubInstallation(input());
      try {
        await waitForLockWaiters(db, { queryLike: "%pg_advisory_xact_lock%" });
      } finally {
        hold.release();
      }
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.status)).toEqual([
        "created",
        "reconnected",
      ]);
      expect(await rows()).toHaveLength(1);
      expect(results[0]).toMatchObject({
        connection: { id: (await rows())[0]!.id },
      });
      expect(results[1]).toMatchObject({
        connection: { id: (await rows())[0]!.id },
      });
    });

    it("rejects a reconnect whose token mint raced a repository pin edit", async () => {
      const original = await connections.createConnection(
        scope,
        "github-app",
        { ...credentials, repositories: ["acme/api"] },
        options,
      );
      const concurrent = await crypto.encrypt(
        JSON.stringify({
          ...credentials,
          repositories: ["acme/web"],
          access_token: "concurrent-edit-token",
        }),
      );
      homes.mockClear();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          await db.appConnection.update({
            where: { id: original.id },
            data: {
              credentials: concurrent,
              metadata: {
                ...options.metadata,
                repos: ["acme/web"],
                repositorySelection: "selected",
              },
            },
          });
          return Response.json({
            token: "stale-pinned-token",
            expires_at: "2099-01-01T00:00:00Z",
            permissions: { contents: "read" },
          });
        }),
      );
      await expect(
        service.connectGitHubInstallation({
          ...input(),
          reconnectId: original.id,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const current = (await rows())[0]!;
      expect(current.credentials).toBe(concurrent);
      expect(current.metadata).toMatchObject({ repos: ["acme/web"] });
      expect(homes).not.toHaveBeenCalled();
    });

    it("preserves a reconnect's repository pin and remints only that subset", async () => {
      const original = await connections.createConnection(
        scope,
        "github-app",
        { ...credentials, repositories: ["acme/api"] },
        options,
      );
      const fetchMock = vi.fn(async () =>
        Response.json({
          token: "pinned-token",
          expires_at: "2099-01-01T00:00:00Z",
          permissions: { contents: "read" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await service.connectGitHubInstallation({
        ...input(),
        reconnectId: original.id,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ repositories: ["api"] }),
        }),
      );
      const row = (await rows())[0]!;
      expect(JSON.parse(await crypto.decrypt(row.credentials!))).toMatchObject({
        repositories: ["acme/api"],
        access_token: "pinned-token",
      });
      expect(row.metadata).toMatchObject({
        repos: ["acme/api"],
        repositorySelection: "selected",
      });
    });
  },
);
