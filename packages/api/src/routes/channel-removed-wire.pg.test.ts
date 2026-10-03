import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The ACCEPTANCE walk for a presence removed on the Slack side
 * (plans/channel-aware-agents.md), over the real public interfaces — the
 * mounted api app (`createApiApp`), the Slack-signature-verified events
 * route, the dashboard's channels view, and the runner's spawn payload:
 *
 *   1. the agent's dashboard view and spawn payload say it is reachable on
 *      Slack (a live `channels` entry);
 *   2. Slack posts `app_uninstalled` (signed webhook, the real door) →
 *      acked 200, the presence reads `disabled`, the live sandbox's home
 *      generation moved (the agent's doc re-renders);
 *   3. the dashboard view carries `disabled`; the spawn payload's `channels`
 *      entry reads `disabled` (the agent's doc says the app was removed);
 *   4. a REPLAY of the same signed body is a no-op (Slack's unordered pair);
 *   5. an event for the dead app is refused at the door — the verification
 *      cache was invalidated at once, not after its TTL;
 *   6. a stranger's unsigned/forged `app_uninstalled` is 401 and changes
 *      nothing — the door is the signature, never the event type.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;
let getCrypto: typeof import("../providers").getCrypto;
let buildSandboxStartPayload: typeof import("../services/sandbox-service").buildSandboxStartPayload;

const P = "rmwire-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const OWNER = `${P}owner`;
const RUNNER = `${P}runner`;
const TEAM = "T0RMWIRE";
const APP_ID = "A0RMWIRE";
const SIGNING_SECRET = "rm-wire-signing";
const SELF_URL = "https://api.rmwire.test";

let currentSession: { id: string; email: string } | null = null;

const signedHeaders = (rawBody: string, secret = SIGNING_SECRET) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
};

let eventSeq = 0;
const envelope = (event: unknown, eventId?: string) =>
  JSON.stringify({
    type: "event_callback",
    api_app_id: APP_ID,
    team_id: TEAM,
    event_id: eventId ?? `EvRm${++eventSeq}`,
    event,
  });

const postSigned = (raw: string, secret?: string) =>
  app.request("/v1/channels/slack/events", {
    method: "POST",
    headers: signedHeaders(raw, secret),
    body: raw,
  });

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  // The spawn payload embeds the gateway CA; without one every compose
  // answers `unavailable` before it reaches the `channels` field under test
  // (the conversation.pg.test.ts pin — CI has no ca.pem on disk).
  process.env.GATEWAY_CA_CERT =
    "-----BEGIN CERTIFICATE-----\nrm-wire-fake-ca\n-----END CERTIFICATE-----";

  ({ db } = await import("@onecli/db"));
  const providers = await import("../providers");
  getCrypto = providers.getCrypto;
  providers.initSelfUrl(SELF_URL);
  ({ buildSandboxStartPayload } = await import("../services/sandbox-service"));

  const { createApiApp } = await import("../app");
  app = createApiApp(
    { getSession: async () => currentSession },
    { selfUrl: SELF_URL },
  );

  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: RUNNER } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.policyRuleTarget.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
  await db.workspaceAccess.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Removed Wire", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.com`,
      externalAuthId: OWNER,
      name: "Olive Owner",
    },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: OWNER,
      userEmail: `${OWNER}@example.com`,
      role: "owner",
    },
  });
  await db.workspaceAccess.create({
    data: { workspaceId: WORKSPACE, userId: OWNER, role: "owner" },
  });
  await db.runner.create({
    data: { id: RUNNER, name: `${P}runner`, token: `rnr_${P}runner` },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: RUNNER } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.channelAdapter.deleteMany({
    where: { token: { startsWith: `cha_${P}` } },
  });
});

describe.skipIf(!PROOF_URL)(
  "a Slack-side uninstall — the acceptance walk over the real wire",
  () => {
    it("signed app_uninstalled → disabled everywhere the agent and the dashboard look; replay inert; dead app refused; forgery 401", async () => {
      // ── Seed a channel-ready agent with a LIVE sandbox and an LLM key (the
      // spawn payload refuses to compose without one). ──
      const agent = await db.agent.create({
        data: {
          workspaceId: WORKSPACE,
          name: "wire agent",
          identifier: `${P}agent`,
          accessToken: `aoc_${P}agent`,
          kind: "hosted",
          harness: "fake",
        },
        select: { id: true },
      });
      const secret = await db.secret.create({
        data: {
          scope: "workspace",
          workspaceId: WORKSPACE,
          name: `${P}key`,
          type: "anthropic",
          encryptedValue: await getCrypto().encrypt("sk-ant-test"),
          hostPattern: "api.anthropic.com",
          metadata: { authMode: "api-key" },
        },
        select: { id: true },
      });
      await db.policyRuleV2.create({
        data: {
          scope: "workspace",
          workspaceId: WORKSPACE,
          status: "published",
          generation: 1,
          priority: 10,
          isDefault: false,
          enabled: true,
          source: "equipment",
          logicalId: `${P}rule`,
          name: `${P}rule`,
          action: "allow",
          requireApproval: false,
          identities: { create: [{ agentId: agent.id }] },
          targets: { create: [{ kind: "secret", secretId: secret.id }] },
        },
      });
      const sandbox = await db.sandbox.create({
        data: {
          agentId: agent.id,
          runnerId: RUNNER,
          status: "running",
          homeDesiredGeneration: 1,
        },
        select: { id: true },
      });
      const integration = await db.channelIntegration.create({
        data: {
          organizationId: ORG,
          provider: "slack",
          externalId: TEAM,
          name: "Removed Wire Co",
          createdByUserId: OWNER,
        },
        select: { id: true },
      });
      const presence = await db.agentChannel.create({
        data: {
          agentId: agent.id,
          integrationId: integration.id,
          provider: "slack",
          externalId: APP_ID,
          identityRef: "UBOT",
          identityName: "wire",
          transport: "events",
          status: "active",
          credentials: await getCrypto().encrypt(
            JSON.stringify({
              botToken: "xoxb-wire",
              signingSecret: SIGNING_SECRET,
            }),
          ),
          createdByUserId: OWNER,
        },
        select: { id: true },
      });

      // ── 1. BEFORE: the agent's spawn payload and the dashboard both say
      // "reachable on Slack as @wire in Removed Wire Co". ──
      const before = await buildSandboxStartPayload(sandbox.id, RUNNER);
      expect(before.ok).toBe(true);
      if (!before.ok) throw new Error("payload");
      expect(before.payload.channels).toEqual([
        {
          provider: "slack",
          status: "active",
          handle: "wire",
          workspaceName: "Removed Wire Co",
        },
      ]);
      currentSession = { id: OWNER, email: `${OWNER}@example.com` };
      const viewBefore = await app.request(`/v1/agents/${agent.id}/channels`, {
        headers: { "x-workspace-id": WORKSPACE },
      });
      expect(viewBefore.status).toBe(200);
      const presencesBefore = (
        (await viewBefore.json()) as { presences: { status: string }[] }
      ).presences;
      expect(presencesBefore.map((p) => p.status)).toEqual(["active"]);

      // Warm the events route's verification cache with a benign signed
      // event, so step 5 proves INVALIDATION rather than a cold miss.
      const warm = await postSigned(
        envelope({ type: "message", subtype: "channel_join" }),
      );
      expect(warm.status).toBe(200);

      // ── 2. THE REAL DOOR: Slack posts app_uninstalled, signed. ──
      const uninstallRaw = envelope({ type: "app_uninstalled" }, "EvRmUninst");
      const uninstallRes = await postSigned(uninstallRaw);
      expect(uninstallRes.status).toBe(200);

      const row = await db.agentChannel.findUnique({
        where: { id: presence.id },
        select: { status: true, apiKeyId: true, externalId: true },
      });
      expect(row).toEqual({
        status: "disabled",
        apiKeyId: null,
        externalId: APP_ID,
      });
      // The live sandbox was told to re-render (the bump is fire-and-forget).
      await vi.waitFor(async () => {
        const moved = await db.sandbox.findUnique({
          where: { id: sandbox.id },
          select: { homeDesiredGeneration: true },
        });
        expect(moved?.homeDesiredGeneration).toBe(2);
      });

      // ── 3. AFTER: what the dashboard and the agent now read. ──
      const viewAfter = await app.request(`/v1/agents/${agent.id}/channels`, {
        headers: { "x-workspace-id": WORKSPACE },
      });
      expect(viewAfter.status).toBe(200);
      const presencesAfter = (
        (await viewAfter.json()) as {
          presences: { status: string; identityName: string | null }[];
        }
      ).presences;
      expect(presencesAfter).toEqual([
        expect.objectContaining({ status: "disabled", identityName: "wire" }),
      ]);
      const after = await buildSandboxStartPayload(sandbox.id, RUNNER);
      if (!after.ok) throw new Error("payload");
      expect(after.payload.channels?.map((c) => c.status)).toEqual([
        "disabled",
      ]);

      // ── 4. Slack REPLAYS the same signed body: acked, nothing changes. ──
      const replay = await postSigned(uninstallRaw);
      expect([200, 401]).toContain(replay.status);
      expect(
        (
          await db.agentChannel.findUnique({
            where: { id: presence.id },
            select: { status: true },
          })
        )?.status,
      ).toBe("disabled");
      expect(
        (
          await db.sandbox.findUnique({
            where: { id: sandbox.id },
            select: { homeDesiredGeneration: true },
          })
        )?.homeDesiredGeneration,
      ).toBe(2);

      // ── 5. The dead app's traffic is refused AT ONCE: a correctly signed
      // message for this app id is 401 — the cache entry warmed above was
      // invalidated by the lifecycle, not aged out (TTL is 60s). ──
      const afterDeath = await postSigned(
        envelope({
          type: "message",
          channel_type: "im",
          channel: "D1",
          user: "U-OWNER",
          text: "hello?",
          ts: "1.1",
        }),
      );
      expect(afterDeath.status).toBe(401);

      // ── 6. A FORGED uninstall (wrong secret) is 401 and moves nothing:
      // reactivate first so the negative control has something to protect. ──
      await db.agentChannel.update({
        where: { id: presence.id },
        data: { status: "active" },
      });
      const forged = await postSigned(
        envelope({ type: "app_uninstalled" }),
        "not-the-secret",
      );
      expect(forged.status).toBe(401);
      expect(
        (
          await db.agentChannel.findUnique({
            where: { id: presence.id },
            select: { status: true },
          })
        )?.status,
      ).toBe("active");
    });

    it("SOCKET transport: the adapter relays tokens_revoked through its cha_ door → disabled, and the presence leaves the adapter's config feed", async () => {
      // A socket-mode presence has no signing secret and no webhook: the
      // channel adapter holds the socket, receives the event, and relays it
      // to `POST /v1/channel-adapter/ingest` under its `cha_` token. The
      // same door the interpret/dispatch pair sits behind.
      const agent = await db.agent.create({
        data: {
          workspaceId: WORKSPACE,
          name: "socket agent",
          identifier: `${P}socket-agent`,
          accessToken: `aoc_${P}socket-agent`,
          kind: "hosted",
          harness: "fake",
        },
        select: { id: true },
      });
      const integration = await db.channelIntegration.findFirstOrThrow({
        where: { organizationId: ORG, provider: "slack" },
        select: { id: true },
      });
      await db.channelAdapter.deleteMany({
        where: { token: { startsWith: `cha_${P}` } },
      });
      const adapter = await db.channelAdapter.create({
        data: {
          token: `cha_${P}adapter`,
          name: `${P}adapter`,
          kind: "anchor",
          lastSeenAt: new Date(),
        },
        select: { id: true },
      });
      // Ownership pinned up front. The config feed's ownership pass is a
      // DB-global fair-share claim (oldest unowned first, ceil(eligible/live)
      // per adapter); the pg lane runs suites in parallel against one
      // database, so left to the pass, this adapter may win a stranger's
      // presence instead of its own. What this test proves is the AFTER
      // side (a removed presence leaves the feed), which holds whoever owns
      // it; the BEFORE side is a precondition, so it is made deterministic.
      const presence = await db.agentChannel.create({
        data: {
          agentId: agent.id,
          integrationId: integration.id,
          provider: "slack",
          externalId: "A0RMSOCKET",
          identityRef: "UBOT2",
          identityName: "sock",
          transport: "socket",
          status: "active",
          credentials: await getCrypto().encrypt(
            JSON.stringify({ botToken: "xoxb-sock", appToken: "xapp-sock" }),
          ),
          createdByUserId: OWNER,
          ownerAdapterId: adapter.id,
          ownerLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
        select: { id: true },
      });
      const adapterHeaders = {
        authorization: `Bearer cha_${P}adapter`,
        "content-type": "application/json",
      };

      // ── BEFORE: the adapter's config feed serves this presence (it holds
      // the socket open for it). ──
      const feedBefore = await app.request("/v1/channel-adapter/config", {
        headers: adapterHeaders,
      });
      expect(feedBefore.status).toBe(200);
      const servedBefore = (
        (await feedBefore.json()) as { presences: { presenceId: string }[] }
      ).presences.map((p) => p.presenceId);
      expect(servedBefore).toContain(presence.id);

      // ── A wrong-family bearer (an agent's aoc_ token) is refused at the
      // door — the event type is irrelevant. ──
      const wrongFamily = await app.request("/v1/channel-adapter/ingest", {
        method: "POST",
        headers: {
          authorization: `Bearer aoc_${P}socket-agent`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          presenceId: presence.id,
          eventId: "EvSockForged",
          event: { type: "app_uninstalled" },
        }),
      });
      expect(wrongFamily.status).toBe(401);
      expect(
        (
          await db.agentChannel.findUnique({
            where: { id: presence.id },
            select: { status: true },
          })
        )?.status,
      ).toBe("active");

      // ── THE REAL DOOR: the adapter relays tokens_revoked (bot entry). ──
      const ingest = await app.request("/v1/channel-adapter/ingest", {
        method: "POST",
        headers: adapterHeaders,
        body: JSON.stringify({
          presenceId: presence.id,
          eventId: "EvSockRevoked",
          event: { type: "tokens_revoked", tokens: { bot: ["UBOT2"] } },
        }),
      });
      expect(ingest.status).toBe(200);
      // Ignored-shaped on the wire: the bot token is dead, nothing to post.
      expect(await ingest.json()).toMatchObject({ kind: "ignored" });
      expect(
        (
          await db.agentChannel.findUnique({
            where: { id: presence.id },
            select: { status: true },
          })
        )?.status,
      ).toBe("disabled");

      // ── AFTER: the config feed no longer serves it — the adapter's
      // reconcile pass closes the socket on the next poll. ──
      const feedAfter = await app.request("/v1/channel-adapter/config", {
        headers: adapterHeaders,
      });
      expect(feedAfter.status).toBe(200);
      const servedAfter = (
        (await feedAfter.json()) as { presences: { presenceId: string }[] }
      ).presences.map((p) => p.presenceId);
      expect(servedAfter).not.toContain(presence.id);

      // And the dashboard reads it the same way the events arm did.
      currentSession = { id: OWNER, email: `${OWNER}@example.com` };
      const view = await app.request(`/v1/agents/${agent.id}/channels`, {
        headers: { "x-workspace-id": WORKSPACE },
      });
      expect(view.status).toBe(200);
      expect(
        ((await view.json()) as { presences: { status: string }[] }).presences,
      ).toEqual([expect.objectContaining({ status: "disabled" })]);
    });
  },
);
