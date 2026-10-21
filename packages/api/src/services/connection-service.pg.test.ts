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
import { proofDatabaseUrl } from "../testing/pg-proof";

vi.mock("./home-sync-service", () => ({ bumpHomeForScope: async () => {} }));
const cache = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock("../lib/gateway-invalidate", () => ({
  invalidateGatewayCacheForOrg: cache.invalidate,
}));
const url = proofDatabaseUrl();
let db: typeof import("@onecli/db").db;
let service: typeof import("./connection-service");
let crypto: ReturnType<typeof import("../providers").getCrypto>;
const org = "connection-persistence-org";
const foreign = "connection-persistence-foreign";
const ws = "connection-persistence-ws";
const otherWs = "connection-persistence-other-ws";
const scope = { workspaceId: ws };
const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const grant = {
  type: "github_app",
  app_id: "123",
  installation_id: "456",
  access_token: "copy-token",
  expires_at: 1234,
  repositories: ["acme/api"],
};
const seed = async (
  id: string,
  credentials: unknown = { ...grant, private_key: key },
  sourceConnectionId?: string,
  workspaceId = ws,
  provider = "github-app",
) =>
  db.appConnection.create({
    data: {
      id: `connection-persistence-${id}`,
      workspaceId,
      provider,
      sourceConnectionId,
      credentials: await crypto.encrypt(JSON.stringify(credentials)),
      metadata: {
        installationId: "456",
        repositorySelection: "selected",
        repos: ["acme/api"],
      },
    },
  });
const read = async (id: string) =>
  db.appConnection.findUniqueOrThrow({ where: { id } });
const raw = async (id: string): Promise<unknown> =>
  JSON.parse(await crypto.decrypt((await read(id)).credentials!));

beforeAll(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
  ({ db } = await import("@onecli/db"));
  (await import("../edition-defaults")).ensureEditionDefaults();
  crypto = (await import("../providers")).getCrypto();
  service = await import("./connection-service");
  await db.appConnection.deleteMany({
    where: { id: { startsWith: "connection-persistence-" } },
  });
  await db.organization.createMany({
    data: [org, foreign].map((id) => ({ id, name: id, slug: id })),
    skipDuplicates: true,
  });
  await db.workspace.createMany({
    data: [
      { id: ws, name: ws, organizationId: org },
      { id: otherWs, name: otherWs, organizationId: foreign },
    ],
    skipDuplicates: true,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  cache.invalidate.mockClear();
  vi.unstubAllGlobals();
  if (url)
    await db.appConnection.deleteMany({
      where: { id: { startsWith: "connection-persistence-" } },
    });
});
afterAll(async () => {
  if (!url) return;
  await db.workspace.deleteMany({ where: { id: { in: [ws, otherWs] } } });
  await db.organization.deleteMany({ where: { id: { in: [org, foreign] } } });
  await db.$disconnect();
});

describe.skipIf(!url)("connection persistence on PostgreSQL", () => {
  it("refuses deletion outside the caller's tenant without changing the row", async () => {
    const connection = await seed(
      "foreign",
      { ...grant, private_key: key },
      undefined,
      otherWs,
    );
    await expect(
      service.deleteConnection(scope, connection.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await read(connection.id)).toEqual(connection);
  });
  it("hands over the effective source key even if a copy stores another valid unused key", async () => {
    const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString();
    const source = await seed("source");
    const copy = await seed(
      "copy",
      { ...grant, private_key: otherKey },
      source.id,
    );
    await service.deleteConnection(scope, source.id);
    expect(await raw(copy.id)).toEqual({ ...grant, private_key: key });
    expect((await read(copy.id)).sourceConnectionId).toBeNull();
    expect((await read(copy.id)).metadata).toEqual(copy.metadata);
  });
  it("does not apply GitHub installation dedupe to another provider's promotion", async () => {
    const github = await seed("github");
    await db.appConnection.update({
      where: { id: github.id },
      data: { scope: "organization", organizationId: org, workspaceId: null },
    });
    const unrelated = await seed(
      "other-provider",
      { access_token: "other-token" },
      undefined,
      ws,
      "github",
    );
    await service.promoteConnectionToOrganization(ws, org, unrelated.id);
    expect(await read(unrelated.id)).toMatchObject({
      scope: "organization",
      organizationId: org,
      workspaceId: null,
      credentials: unrelated.credentials,
    });
  });
  it.each(["app_id", "installation_id"])(
    "refuses reconnect with a different %s",
    async (field) => {
      const source = await seed("source");
      await expect(
        service.reconnectConnection(
          scope,
          source.id,
          { ...grant, private_key: key, [field]: "999" },
          { metadata: {} },
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await read(source.id)).toEqual(source);
    },
  );

  it("treats a historical null repository pin as unrestricted on reconnect and detach", async () => {
    const source = await seed("source", {
      ...grant,
      private_key: key,
      repositories: null,
    });
    const copy = await seed(
      "copy",
      { ...grant, repositories: null },
      source.id,
    );
    await service.reconnectConnection(
      scope,
      source.id,
      { ...grant, private_key: key, repositories: null },
      { metadata: {} },
    );
    await service.deleteConnection(scope, source.id);
    expect(await raw(copy.id)).toEqual({
      ...grant,
      private_key: key,
      repositories: null,
    });
  });
  it("rolls back deletion rather than overwriting concurrently refreshed copy credentials", async () => {
    const source = await seed("source");
    const copy = await seed("copy", grant, source.id);
    const concurrent = await crypto.encrypt(
      JSON.stringify({ ...grant, access_token: "concurrent-token" }),
    );
    const encrypt = crypto.encrypt.bind(crypto);
    vi.spyOn(crypto, "encrypt").mockImplementationOnce(async (text) => {
      await db.appConnection.update({
        where: { id: copy.id },
        data: { credentials: concurrent },
      });
      return encrypt(text);
    });
    await expect(
      service.deleteConnection(scope, source.id),
    ).rejects.toMatchObject({ code: "P2034" });
    expect(await read(source.id)).toEqual(source);
    expect((await read(copy.id)).sourceConnectionId).toBe(source.id);
    expect((await read(copy.id)).credentials).toBe(concurrent);
    expect(cache.invalidate).not.toHaveBeenCalled();
  });
  it("detaches atomically and preserves each copy's pin, token and metadata", async () => {
    const source = await seed("source");
    const copy = await seed("copy", grant, source.id);
    await service.deleteConnection(scope, source.id);
    expect(
      await db.appConnection.findUnique({ where: { id: source.id } }),
    ).toBeNull();
    expect((await read(copy.id)).sourceConnectionId).toBeNull();
    expect(await raw(copy.id)).toEqual({ ...grant, private_key: key });
    expect((await read(copy.id)).metadata).toEqual(copy.metadata);
    expect(cache.invalidate).toHaveBeenCalledExactlyOnceWith(org);
  });

  it.each([
    ["foreign tenant", grant, otherWs, "github-app"],
    ["other provider", grant, ws, "github"],
    ["other app", { ...grant, app_id: "999" }, ws, "github-app"],
    [
      "other installation",
      { ...grant, installation_id: "999" },
      ws,
      "github-app",
    ],
    ["invalid credentials", null, ws, "github-app"],
    ["empty pin", { ...grant, repositories: [] }, ws, "github-app"],
    [
      "invalid own key",
      { ...grant, private_key: "not-a-key" },
      ws,
      "github-app",
    ],
  ])(
    "rolls back every earlier detach for %s",
    async (_name, credentials, workspaceId, provider) => {
      const source = await seed("source");
      const good = await seed("a-good", grant, source.id);
      const bad = await seed(
        "z-bad",
        credentials,
        source.id,
        workspaceId,
        provider,
      );
      await expect(
        service.deleteConnection(scope, source.id),
      ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
      expect(await read(source.id)).toEqual(source);
      expect(await read(good.id)).toEqual(good);
      expect(await read(bad.id)).toEqual(bad);
    },
  );

  it("refuses handing over a borrowed source key", async () => {
    const original = await seed("original");
    const source = await seed(
      "source",
      { ...grant, private_key: key },
      original.id,
    );
    const copy = await seed("copy", grant, source.id);
    await expect(
      service.deleteConnection(scope, source.id),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    expect(await read(copy.id)).toEqual(copy);
  });

  it("refuses an invalid original signing key without deleting or unlinking", async () => {
    const source = await seed("source", { ...grant, private_key: "not-a-key" });
    const copy = await seed("copy", grant, source.id);
    await expect(
      service.deleteConnection(scope, source.id),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    expect(await read(source.id)).toEqual(source);
    expect(await read(copy.id)).toEqual(copy);
  });

  it("reconnect re-mints the retained pin and records selected metadata", async () => {
    const source = await seed("source");
    const requests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        return Response.json({
          token: "narrow-token",
          expires_at: "2026-10-22T00:00:00Z",
          permissions: { contents: "read" },
        });
      }),
    );
    await service.reconnectConnection(
      scope,
      source.id,
      {
        ...grant,
        repositories: undefined,
        private_key: key,
        access_token: "wide-token",
      },
      {
        metadata: {
          repositorySelection: "all",
          repos: ["acme/api", "acme/private"],
        },
      },
    );
    expect(requests).toEqual([{ repositories: ["api"] }]);
    expect(await raw(source.id)).toMatchObject({
      repositories: ["acme/api"],
      access_token: "narrow-token",
    });
    expect((await read(source.id)).metadata).toMatchObject({
      repositorySelection: "selected",
      repos: ["acme/api"],
      tags: ["api"],
      permissions: { contents: "read" },
    });
  });

  it("does not overwrite a concurrent reconnect edit after minting", async () => {
    const source = await seed("source");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await db.appConnection.update({
          where: { id: source.id },
          data: { label: "concurrent rename" },
        });
        return Response.json({
          token: "narrow-token",
          expires_at: "2026-10-22T00:00:00Z",
          permissions: {},
        });
      }),
    );
    await expect(
      service.reconnectConnection(
        scope,
        source.id,
        { ...grant, private_key: key },
        { metadata: { repositorySelection: "all" } },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await read(source.id)).label).toBe("concurrent rename");
    expect((await read(source.id)).credentials).toBe(source.credentials);
  });

  it("keeps the stored connection intact if the pinned mint fails", async () => {
    const source = await seed("source");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "refused" }, { status: 403 })),
    );
    await expect(
      service.reconnectConnection(
        scope,
        source.id,
        { ...grant, private_key: key },
        { metadata: {} },
      ),
    ).rejects.toThrow();
    expect(await read(source.id)).toEqual(source);
  });
});
