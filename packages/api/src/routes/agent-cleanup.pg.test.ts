import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { proofDatabaseUrl } from "../testing/pg-proof";

const PROOF_URL = proofDatabaseUrl();
const P = "cleanup-wire-";
const ORG = `${P}org`;
const WORKSPACE = `${P}workspace`;
const USER = `${P}user`;
const AGENT = `${P}agent`;
const APP = "A-CLEANUP-WIRE";
const TEAM = "T-CLEANUP-WIRE";
const ADAPTER_TOKEN = `cha_${P}instance`;
let db: typeof import("@onecli/db").db;
let app: ReturnType<typeof import("../app").createApiApp>;
let crypto: ReturnType<typeof import("../providers").getCrypto>;
let server: Server;
let session: { id: string; email: string } | null = null;
let uninstallFails = true;
let methods: string[] = [];
let integrationId: string;
let encryptedCredentials: string;
let serviceKeyId: string;
let adapterId: string;

const clearFixtures = async () => {
  await db.channelCleanup.deleteMany({ where: { organizationId: ORG } });
  await db.agent.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { userId: USER } });
  await db.apiKey.deleteMany({ where: { userId: USER } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: USER } });
  await db.channelAdapter.deleteMany({ where: { token: ADAPTER_TOKEN } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  const baseUrl = await new Promise<string>((resolve) => {
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const method = (request.url ?? "").slice(1);
        methods.push(method);
        response.writeHead(200, { "content-type": "application/json" });
        const result =
          method === "apps.uninstall"
            ? uninstallFails
              ? { ok: false, error: "internal_error" }
              : { ok: true }
            : method === "apps.manifest.delete" ||
                method === "v1/cache/invalidate"
              ? { ok: true }
              : { ok: false, error: "test_unexpected_method" };
        response.end(JSON.stringify(result));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
  process.env.SLACK_API_BASE_URL = baseUrl;
  process.env.GATEWAY_INTERNAL_URL = baseUrl;
  ({ db } = await import("@onecli/db"));
  crypto = (await import("../providers")).getCrypto();
  app = (await import("../app")).createApiApp({
    getSession: async () => session,
  });
  await clearFixtures();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, organizationId: ORG, name: WORKSPACE },
  });
  await db.user.create({
    data: { id: USER, externalAuthId: USER, email: `${USER}@example.com` },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: USER,
      userEmail: `${USER}@example.com`,
      role: "owner",
    },
  });
  ({ id: adapterId } = await db.channelAdapter.create({
    data: { token: ADAPTER_TOKEN, name: P, kind: "instance" },
    select: { id: true },
  }));
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  session = { id: USER, email: `${USER}@example.com` };
  methods = [];
  uninstallFails = true;
  await db.channelCleanup.deleteMany({ where: { organizationId: ORG } });
  await db.agent.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  const integration = await db.channelIntegration.create({
    data: { organizationId: ORG, provider: "slack", externalId: TEAM },
  });
  integrationId = integration.id;
  await db.apiKey.deleteMany({ where: { userId: USER } });
  const serviceKey = await db.apiKey.create({
    data: {
      userId: USER,
      userEmail: `${USER}@example.com`,
      workspaceId: WORKSPACE,
      key: `oc_${P}service`,
      kind: "service",
    },
  });
  serviceKeyId = serviceKey.id;
  encryptedCredentials = await crypto.encrypt(
    JSON.stringify({
      botToken: "xoxb-cleanup-proof",
      clientId: "cleanup-client",
      clientSecret: "cleanup-secret",
    }),
  );
  await db.agent.create({
    data: {
      id: AGENT,
      workspaceId: WORKSPACE,
      name: "Cleanup proof",
      identifier: P,
      accessToken: `aoc_${P}agent`,
      kind: "hosted",
      harness: "jcode",
      channels: {
        create: {
          integrationId,
          provider: "slack",
          externalId: APP,
          identityRef: "U-CLEANUP-WIRE",
          transport: "events",
          status: "active",
          credentials: encryptedCredentials,
          apiKeyId: serviceKeyId,
          // Ownership pinned up front. The adapter config feed's ownership
          // pass is a DB-global fair-share claim, and the pg lane runs suites
          // in parallel against one database: left unowned, this presence
          // would be claimed by a stranger suite's adapter and skew ITS
          // fleet assertions. Nothing here depends on who owns it.
          ownerAdapterId: adapterId,
          ownerLeaseExpiresAt: new Date(Date.now() + 60 * 60_000),
        },
      },
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await clearFixtures();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

const deleteAgent = () =>
  app.request(`/v1/agents/${AGENT}`, {
    method: "DELETE",
    headers: { "x-workspace-id": WORKSPACE },
  });
const maintenance = (token = ADAPTER_TOKEN) =>
  app.request("/v1/channel-adapter/rotate-integrations", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
/** The maintenance route kicks the cleanup pass DETACHED (the adapter's
 * client aborts at 15s; the pass may spend minutes on provider calls), so
 * its effects land after the response: wait for the job to settle. */
const settled = (id: string, state: string) =>
  vi.waitFor(
    async () =>
      expect(
        await db.channelCleanup.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ state }),
    { timeout: 10_000 },
  );

const repairConfiguration = () =>
  crypto
    .encrypt(
      JSON.stringify({
        accessToken: "configuration-proof",
        refreshToken: "refresh-proof",
        expiresAt: Math.floor(Date.now() / 1000) + 43200,
      }),
    )
    .then((credentials) =>
      db.channelIntegration.update({
        where: { id: integrationId },
        data: { credentials, credentialsRotatedAt: new Date() },
      }),
    );

describe.skipIf(!PROOF_URL)("agent cleanup through public HTTP routes", () => {
  it("rejects unauthenticated deletion without enqueue or provider calls", async () => {
    session = null;
    expect((await deleteAgent()).status).toBe(401);
    expect(await db.agent.count({ where: { id: AGENT } })).toBe(1);
    expect(await db.channelCleanup.count({ where: { externalId: APP } })).toBe(
      0,
    );
    expect(methods).toEqual([]);
  });

  it("returns local deletion success but durably retries remote failure through authenticated maintenance", async () => {
    expect((await deleteAgent()).status).toBe(204);
    expect(await db.agent.count({ where: { id: AGENT } })).toBe(0);
    expect(await db.agentChannel.count({ where: { externalId: APP } })).toBe(0);
    expect(await db.apiKey.count({ where: { id: serviceKeyId } })).toBe(0);
    const job = await db.channelCleanup.findUniqueOrThrow({
      where: { provider_externalId: { provider: "slack", externalId: APP } },
    });
    expect(job).toMatchObject({
      organizationId: ORG,
      integrationId,
      teamId: TEAM,
      stage: "uninstall",
      state: "retry",
      credentials: encryptedCredentials,
    });
    expect(methods.filter((method) => method.startsWith("apps."))).toEqual([
      "apps.uninstall",
    ]);
    const missing = await app.request(`/v1/agents/${AGENT}`, {
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(missing.status).toBe(404);

    const beforeUnauthorized = methods.length;
    expect((await maintenance("oc_wrong-family")).status).toBe(401);
    expect((await maintenance("cha_nonexistent")).status).toBe(401);
    expect(methods).toHaveLength(beforeUnauthorized);

    // Simulate a repaired org connection, then let the PUBLIC maintenance
    // route resume from the persisted job with no remaining live presence.
    await repairConfiguration();
    await db.channelCleanup.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(0) },
    });
    uninstallFails = false;
    methods = [];
    const response = await maintenance();
    expect(response.status).toBe(200);
    expect(await response.text()).not.toMatch(
      /xoxb|cleanup-secret|credentials|completed|retained/,
    );
    await settled(job.id, "completed");
    expect(methods.indexOf("apps.uninstall")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("apps.manifest.delete")).toBeGreaterThan(
      methods.indexOf("apps.uninstall"),
    );
    expect(
      await db.channelCleanup.findUniqueOrThrow({ where: { id: job.id } }),
    ).toMatchObject({ state: "completed", credentials: null });
    methods = [];
    expect((await maintenance()).status).toBe(200);
    // A completed job is never claimed again: give a detached pass a moment
    // to prove it stays quiet.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(methods).toEqual([]);
  });

  it("resumes manifest deletion after reconnect without repeating confirmed uninstall", async () => {
    uninstallFails = false;
    expect((await deleteAgent()).status).toBe(204);
    const job = await db.channelCleanup.findUniqueOrThrow({
      where: { provider_externalId: { provider: "slack", externalId: APP } },
    });
    expect(job).toMatchObject({ stage: "manifest", state: "retry" });
    expect(methods.filter((method) => method.startsWith("apps."))).toEqual([
      "apps.uninstall",
    ]);
    await repairConfiguration();
    await db.channelCleanup.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(0) },
    });
    uninstallFails = true;
    methods = [];
    expect((await maintenance()).status).toBe(200);
    await settled(job.id, "completed");
    expect(methods).toEqual(["apps.manifest.delete"]);
    expect(
      await db.channelCleanup.findUniqueOrThrow({ where: { id: job.id } }),
    ).toMatchObject({ state: "completed", credentials: null });
  });

  it("cannot delete a foreign tenant's agent or create cleanup work for it", async () => {
    const foreign = `${P}foreign`;
    await db.organization.create({
      data: { id: foreign, name: foreign, slug: foreign },
    });
    await db.workspace.create({
      data: { id: foreign, name: foreign, organizationId: foreign },
    });
    await db.agent.create({
      data: {
        id: foreign,
        workspaceId: foreign,
        identifier: foreign,
        name: foreign,
        accessToken: `aoc_${foreign}`,
      },
    });
    try {
      const response = await app.request(`/v1/agents/${foreign}`, {
        method: "DELETE",
        headers: { "x-workspace-id": WORKSPACE },
      });
      expect(response.status).toBe(404);
      expect(await db.agent.count({ where: { id: foreign } })).toBe(1);
      expect(
        await db.channelCleanup.count({ where: { organizationId: foreign } }),
      ).toBe(0);
      expect(methods).toEqual([]);
    } finally {
      await db.agent.delete({ where: { id: foreign } });
      await db.workspace.delete({ where: { id: foreign } });
      await db.organization.delete({ where: { id: foreign } });
    }
  });
});
