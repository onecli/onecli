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
import { proofDatabaseUrl } from "../../testing/pg-proof";

const PROOF_URL = proofDatabaseUrl();
const ORG = "rotation-regression-org";
const OWNER = "rotation-regression-owner";
const TEAM = "T-ROTATION";
const rotatedAt = new Date("2020-01-01T00:00:00Z");
let db: typeof import("@onecli/db").db;
let service: typeof import("./channel-integration-service");
let crypto: ReturnType<typeof import("../../providers").getCrypto>;
let integrationId: string;
let ciphertext: string;
const stored = JSON.stringify({
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: Math.floor(Date.now() / 1000) + 300,
});

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  ({ db } = await import("@onecli/db"));
  service = await import("./channel-integration-service");
  crypto = (await import("../../providers")).getCrypto();
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.organization.upsert({
    where: { id: ORG },
    create: { id: ORG, name: ORG, slug: ORG },
    update: {},
  });
  await db.user.upsert({
    where: { id: OWNER },
    create: { id: OWNER, email: `${OWNER}@example.com`, externalAuthId: OWNER },
    update: {},
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  ciphertext = await crypto.encrypt(stored);
  const row = await db.channelIntegration.create({
    data: {
      organizationId: ORG,
      provider: "slack",
      externalId: TEAM,
      credentials: ciphertext,
      credentialsRotatedAt: rotatedAt,
      createdByUserId: OWNER,
    },
  });
  integrationId = row.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => {
  if (!PROOF_URL) return;
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.organization.delete({ where: { id: ORG } });
  await db.user.delete({ where: { id: OWNER } });
});

const readRow = () =>
  db.channelIntegration.findUniqueOrThrow({ where: { id: integrationId } });
const success = (team = TEAM) =>
  new Response(
    JSON.stringify({
      ok: true,
      token: "new-access",
      refresh_token: "new-refresh",
      team_id: team,
      exp: Math.floor(Date.now() / 1000) + 43200,
    }),
  );
const failureCases: [string, () => Promise<Response>][] = [
  [
    "connect timeout",
    async () => {
      throw new TypeError("fetch failed", {
        cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
      });
    },
  ],
  [
    "HTTP 429",
    async () =>
      new Response('{"ok":false,"error":"invalid_refresh_token"}', {
        status: 429,
        headers: { "retry-after": "0" },
      }),
  ],
  [
    "HTTP 503",
    async () =>
      new Response('{"ok":false,"error":"invalid_refresh_token"}', {
        status: 503,
      }),
  ],
  [
    "unknown refusal",
    async () => new Response('{"ok":false,"error":"future_error"}'),
  ],
  ["malformed JSON", async () => new Response("not json")],
  ["malformed success", async () => new Response('{"ok":true}')],
];

describe.skipIf(!PROOF_URL)(
  "integration rotation preserves credentials unless permanently refused",
  () => {
    it.each(["config", "shared"])(
      "%s rejects an already replaced integration or reconnected tenant before any callback",
      async (path) => {
        const { slackProvider } = await import("./providers/slack/provider");
        const shared = slackProvider.sharedApp!;
        vi.spyOn(shared, "configured").mockReturnValue(path === "shared");
        const mint = vi.spyOn(shared, "tryMintWith");
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        const work = vi.fn();
        for (const expectedIdentity of [
          { integrationId: "replaced-integration", externalId: TEAM },
          { integrationId, externalId: "T-ORIGINAL" },
        ]) {
          await expect(
            service.withFreshIntegrationCredentials(
              ORG,
              "slack",
              work,
              expectedIdentity,
            ),
          ).rejects.toMatchObject({ code: "CONFLICT" });
        }
        expect(work).not.toHaveBeenCalled();
        expect(mint).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      },
    );

    it.each(["callback integration", "reconnected tenant", "replacement row"])(
      "shared callback rechecks %s after credential resolution",
      async (change) => {
        const { slackProvider } = await import("./providers/slack/provider");
        const shared = slackProvider.sharedApp!;
        vi.spyOn(shared, "configured").mockReturnValue(true);
        vi.spyOn(shared, "tryMintWith").mockImplementation(async ({ fn }) => {
          if (change === "reconnected tenant") {
            await db.channelIntegration.update({
              where: { id: integrationId },
              data: { externalId: "T-NEW" },
            });
          } else if (change === "replacement row") {
            await db.channelIntegration.update({
              where: { id: integrationId },
              data: { id: `${integrationId}-replacement` },
            });
          }
          return {
            result: await fn(
              "shared-access",
              change === "callback integration" ? "wrong-id" : integrationId,
            ),
          };
        });
        const work = vi.fn();
        await expect(
          service.withFreshIntegrationCredentials(ORG, "slack", work, {
            integrationId,
            externalId: TEAM,
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(work).not.toHaveBeenCalled();
      },
    );

    it("config callback rechecks tenant identity after rotation", async () => {
      // Simulate an identity writer racing the credential persistence. The
      // guard must inspect the current binding, not the pre-rotation snapshot.
      const encrypt = crypto.encrypt.bind(crypto);
      vi.spyOn(crypto, "encrypt").mockImplementationOnce(async (plaintext) => {
        await db.channelIntegration.update({
          where: { id: integrationId },
          data: { externalId: "T-NEW" },
        });
        return encrypt(plaintext);
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async () => success()),
      );
      const work = vi.fn();
      await expect(
        service.withFreshIntegrationCredentials(ORG, "slack", work, {
          integrationId,
          externalId: TEAM,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(work).not.toHaveBeenCalled();
    });

    it.each(["config", "shared"])(
      "%s allows a matching expected identity",
      async (path) => {
        const { slackProvider } = await import("./providers/slack/provider");
        const shared = slackProvider.sharedApp!;
        vi.spyOn(shared, "configured").mockReturnValue(path === "shared");
        vi.spyOn(shared, "tryMintWith").mockImplementation(async ({ fn }) => ({
          result: await fn("shared-access", integrationId),
        }));
        vi.stubGlobal(
          "fetch",
          vi.fn().mockImplementation(async () => success()),
        );
        const work = vi.fn().mockResolvedValue("done");
        await expect(
          service.withFreshIntegrationCredentials(ORG, "slack", work, {
            integrationId,
            externalId: TEAM,
          }),
        ).resolves.toBe("done");
        expect(work).toHaveBeenCalledExactlyOnceWith(
          path === "shared" ? "shared-access" : "new-access",
          integrationId,
        );
      },
    );

    it.each(["not json", '{"accessToken":"incomplete"}'])(
      "clears a malformed stored credential without provider calls: %s",
      async (malformed) => {
        const credentials = await crypto.encrypt(malformed);
        await db.channelIntegration.update({
          where: { id: integrationId },
          data: { credentials },
        });
        const fetch = vi.fn();
        const work = vi.fn();
        vi.stubGlobal("fetch", fetch);
        await expect(
          service.withFreshIntegrationCredentials(ORG, "slack", work),
        ).rejects.toBeInstanceOf(Error);
        expect(fetch).not.toHaveBeenCalled();
        expect(work).not.toHaveBeenCalled();
        expect(await readRow()).toMatchObject({
          credentials: null,
          credentialsRotatedAt: rotatedAt,
        });
      },
    );

    it.each(failureCases)(
      "on-use %s preserves both fields, uses the live access token, and allows retry",
      async (_name, respond) => {
        const fetch = vi.fn().mockImplementation(respond);
        vi.stubGlobal("fetch", fetch);
        const work = vi.fn();
        await service.withFreshIntegrationCredentials(ORG, "slack", work);
        expect(work).toHaveBeenCalledExactlyOnceWith(
          "old-access",
          integrationId,
        );
        work.mockClear();
        expect(await readRow()).toMatchObject({
          credentials: ciphertext,
          credentialsRotatedAt: rotatedAt,
          externalId: TEAM,
        });
        expect((await service.getIntegrationView(ORG))[0]).toMatchObject({
          hasCredentials: true,
          needsCredentials: false,
        });

        fetch.mockImplementation(async () => success());
        await service.withFreshIntegrationCredentials(ORG, "slack", work);
        expect(work).toHaveBeenCalledExactlyOnceWith(
          "new-access",
          integrationId,
        );
        const row = await readRow();
        expect(
          JSON.parse(await crypto.decrypt(row.credentials!)),
        ).toMatchObject({
          accessToken: "new-access",
          refreshToken: "new-refresh",
        });
        expect(row.credentialsRotatedAt!.getTime()).toBeGreaterThan(
          rotatedAt.getTime(),
        );
      },
    );

    it.each(failureCases)(
      "sweep %s counts deferral without clearing",
      async (_name, respond) => {
        vi.stubGlobal("fetch", vi.fn().mockImplementation(respond));
        const result = await service.rotateStaleIntegrations();
        expect(result.deferred).toBeGreaterThanOrEqual(1);
        expect(await readRow()).toMatchObject({
          credentials: ciphertext,
          credentialsRotatedAt: rotatedAt,
        });
        // The claim is a retry lease, not loss of the stored credential.
        await db.$executeRaw`UPDATE channel_integrations SET rotate_claimed_at = NULL WHERE id = ${integrationId}`;
        vi.stubGlobal(
          "fetch",
          vi.fn().mockImplementation(async () => success()),
        );
        expect(
          (await service.rotateStaleIntegrations()).rotated,
        ).toBeGreaterThanOrEqual(1);
        expect(
          JSON.parse(await crypto.decrypt((await readRow()).credentials!)),
        ).toMatchObject({ refreshToken: "new-refresh" });
      },
    );

    it.each(["on-use", "sweep"])(
      "%s clears explicit invalid_refresh_token but keeps the failure timestamp",
      async (path) => {
        vi.stubGlobal(
          "fetch",
          vi
            .fn()
            .mockImplementation(
              async () =>
                new Response('{"ok":false,"error":"invalid_refresh_token"}'),
            ),
        );
        const work = vi.fn();
        if (path === "on-use") {
          await expect(
            service.withFreshIntegrationCredentials(ORG, "slack", work),
          ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
          expect(work).not.toHaveBeenCalled();
        } else {
          expect(
            (await service.rotateStaleIntegrations()).failed,
          ).toBeGreaterThanOrEqual(1);
        }
        expect(await readRow()).toMatchObject({
          credentials: null,
          credentialsRotatedAt: rotatedAt,
          externalId: TEAM,
        });
        expect((await service.getIntegrationView(ORG))[0]).toMatchObject({
          hasCredentials: false,
          needsCredentials: true,
        });
      },
    );

    it("retains the tenant-mismatch clear without rebinding", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async () => success("T-FOREIGN")),
      );
      const work = vi.fn();
      await expect(
        service.withFreshIntegrationCredentials(ORG, "slack", work),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(work).not.toHaveBeenCalled();
      expect(await readRow()).toMatchObject({
        credentials: null,
        credentialsRotatedAt: rotatedAt,
        externalId: TEAM,
      });
    });

    it("serializes concurrent on-use rotations so the single-use refresh is consumed once", async () => {
      const fetch = vi.fn().mockImplementation(async () => success());
      vi.stubGlobal("fetch", fetch);
      const work = vi.fn();
      await Promise.all([
        service.withFreshIntegrationCredentials(ORG, "slack", work),
        service.withFreshIntegrationCredentials(ORG, "slack", work),
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(work).toHaveBeenCalledTimes(2);
      expect(
        JSON.parse(await crypto.decrypt((await readRow()).credentials!)),
      ).toMatchObject({ refreshToken: "new-refresh" });
    });
  },
);
