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
describe.skipIf(!PROOF_URL)(
  "integration rotation honors the expected identity (the tenant fence)",
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
  },
);
