import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The reach-grant ACCEPTANCE walk, end to end over the REAL wire: the
 * mounted api app (`createApiApp`), Slack-signature-verified inbound HTTP
 * (the exact production doors: POST /channels/slack/events and
 * /interactivity), and the session-authenticated dashboard PUT. One
 * continuous story, the way a team actually experiences the feature:
 *
 *   1. the agent is invited to #proj (signed webhook) → accepted, and the
 *      workspace owner's DM gets the platform-composed reach card;
 *   2. a stranger mentions the agent (signed webhook) → the soft pending
 *      line, not the harsh refusal;
 *   3. the owner clicks "Allow everyone" on the card (signed interactivity
 *      payload) → decided + card rewritten via response_url;
 *   4. the stranger asks again → a real turn, userId null, guest-framed;
 *   5. the owner revokes from the dashboard (PUT, session auth) → the
 *      stranger is refused again.
 *
 * Only Slack's own origin is faked (it is external by nature) — every
 * OneCLI surface in the walk is the real, mounted production code path.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;
let getCrypto: typeof import("../providers").getCrypto;

const P = "rchwire-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const OWNER = `${P}owner`;
const TEAM = "T-RCH-WIRE";
const APP_ID = "A0RCHWIRE";
const SIGNING_SECRET = "rch-wire-signing";
const SELF_URL = "https://api.rchwire.test";

/** The signed-in dashboard caller (the PUT leg). */
let currentSession: { id: string; email: string } | null = null;

// ── Fake Slack origin (external by nature) + response_url recorder ─────────

let slackServer: Server;
const slackCalls: { method: string; form: URLSearchParams; raw: string }[] = [];
const slackHandlers: Record<string, () => unknown> = {};

const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        const method = (req.url ?? "/").slice(1);
        slackCalls.push({ method, form: new URLSearchParams(raw), raw });
        const handler = slackHandlers[method];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            ...((handler ? handler() : {}) as object),
          }),
        );
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

const slackCallsFor = (method: string) =>
  slackCalls.filter((c) => c.method === method);

const waitForSlackCall = async (
  method: string,
  minCount = 1,
  tries = 60,
): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    if (slackCallsFor(method).length >= minCount) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

// ── The signed wire (the exact production verification) ────────────────────

const signedHeaders = (rawBody: string, contentType: string) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return {
    "content-type": contentType,
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
};

let eventSeq = 0;
const postEvent = (event: unknown) => {
  eventSeq += 1;
  const raw = JSON.stringify({
    type: "event_callback",
    api_app_id: APP_ID,
    event_id: `EvWire${eventSeq}`,
    event,
  });
  return app.request("/v1/channels/slack/events", {
    method: "POST",
    headers: signedHeaders(raw, "application/json"),
    body: raw,
  });
};

const postInteractivity = (payload: unknown) => {
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  return app.request("/v1/channels/slack/interactivity", {
    method: "POST",
    headers: signedHeaders(raw, "application/x-www-form-urlencoded"),
    body: raw,
  });
};

beforeAll(async () => {
  if (!PROOF_URL) return;

  const slackUrl = await startSlackFake();
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = slackUrl;
  process.env.ANTHROPIC_API_BASE_URL = slackUrl;
  process.env.OPENAI_API_BASE_URL = slackUrl;
  // Edition-pinned onprem BEFORE any module import (the channels.pg.test.ts
  // law): CI's ambient EDITION is cloud, whose crypto demands the KMS
  // injection ensureEditionDefaults() does at server boot.
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  // The SHARED fake key (32x7) every pg suite uses: the proof database is
  // one shared fleet, and channels.pg.test.ts's adapter-config tests decrypt
  // EVERY presence's credentials - a row encrypted under a different key
  // would fail its decrypt and fail THAT suite from this one.
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  ({ db } = await import("@onecli/db"));
  const providers = await import("../providers");
  getCrypto = providers.getCrypto;
  providers.initSelfUrl(SELF_URL);

  const { createApiApp } = await import("../app");
  app = createApiApp(
    { getSession: async () => currentSession },
    { selfUrl: SELF_URL },
  );

  // Clean slate, prefix-fenced.
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: ORG },
  });
  await db.policyRuleTarget.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({
    where: { logicalId: { startsWith: P } },
  });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
  await db.workspaceAccess.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Reach Wire", organizationId: ORG },
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
});

afterAll(async () => {
  if (!PROOF_URL) return;
  // Reap this suite's presences: fleet-wide readers in sibling suites
  // (adapter config claims every presence) must never meet our rows.
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.channelAdapter.deleteMany({
    where: { token: { startsWith: `cha_${P}` } },
  });
  await new Promise<void>((resolve) => slackServer.close(() => resolve()));
});

describe.skipIf(!PROOF_URL)(
  "reach grants — the end-to-end acceptance walk over the real wire",
  () => {
    it("invite → owner card → EVERYONE held pending → approve on the card → guest turn → dashboard members_only → refused → blocked → silent", async () => {
      // ── Seed the channel-ready agent (grant an LLM key so turns run). ──
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
          encryptedValue: "enc",
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
      const integration = await db.channelIntegration.create({
        data: {
          organizationId: ORG,
          provider: "slack",
          externalId: TEAM,
          name: "Reach Wire Co",
          createdByUserId: OWNER,
        },
        select: { id: true },
      });
      await db.agentChannel.create({
        data: {
          agentId: agent.id,
          integrationId: integration.id,
          provider: "slack",
          externalId: APP_ID,
          identityRef: "UBOT",
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
      });
      await db.channelUserLink.create({
        data: {
          integrationId: integration.id,
          externalUserId: "U-OWNER",
          userId: OWNER,
          linkedVia: "manual",
        },
      });

      // Slack scripting: owner lookup, channel label, IM open, card post,
      // stranger probe (same tenant).
      slackHandlers["users.info"] = () => ({
        user: {
          id: "U-STRANGER",
          team_id: TEAM,
          name: "dana",
          profile: { display_name: "Dana" },
        },
      });
      slackHandlers["conversations.info"] = () => ({
        channel: { id: "C-WIRE", name: "proj-wire" },
      });
      slackHandlers["conversations.open"] = () => ({
        channel: { id: "D-OWNER" },
      });
      slackHandlers["chat.postMessage"] = () => ({
        channel: "D-OWNER",
        ts: "42.1",
      });
      slackHandlers["chat.update"] = () => ({ ts: "42.1" });

      // ── 1. INVITE (signed webhook, the real events door). ──
      const inviteRes = await postEvent({
        type: "member_joined_channel",
        channel: "C-WIRE",
        user: "UBOT",
        inviter: "U-OWNER",
      });
      expect(inviteRes.status).toBe(200);
      // The owner's DM card went out (detached — poll the fake).
      await waitForSlackCall("chat.postMessage");
      const card = slackCallsFor("chat.postMessage")[0];
      expect(card).toBeDefined();
      const grant = await db.agentReachGrant.findFirstOrThrow({
        where: { agentId: agent.id, externalRef: "C-WIRE" },
      });
      expect(grant.state).toBe("pending");
      expect(grant.subjectLabel).toBe("#proj-wire");
      // The card's buttons carry ONLY the opaque grant id.
      expect(card?.form.get("blocks")).toContain(grant.id);
      expect(card?.form.get("channel")).toBe("D-OWNER");

      // ── 2. STRANGER while pending → the waiting line, posted back. It
      // names the owner and carries the dashboard link, so the room knows
      // who to nudge and that person can settle it in one click. ──
      const pendingRes = await postEvent({
        type: "app_mention",
        channel: "C-WIRE",
        user: "U-STRANGER",
        text: "<@UBOT> can you help?",
        ts: "100.1",
      });
      expect(pendingRes.status).toBe(200);
      await waitForSlackCall("chat.postMessage", 2);
      const softLine = slackCallsFor("chat.postMessage").at(-1);
      expect(softLine?.form.get("text")).toContain("needs to approve me");
      expect(softLine?.form.get("text")).toContain(
        `/agents/${agent.id}/channels`,
      );
      expect(
        await db.turn.count({
          where: { conversation: { agentId: agent.id } },
        }),
      ).toBe(0);

      // ── 2b. THE PRECONDITION, the point of the whole feature: the LINKED
      // OWNER is held too. The grant governs the CHANNEL, so until it is
      // settled the room hears one consistent thing instead of the agent
      // chatting with some people and refusing others. ──
      const memberWhilePending = await postEvent({
        type: "app_mention",
        channel: "C-WIRE",
        user: "U-OWNER",
        text: "<@UBOT> status?",
        ts: "150.1",
      });
      expect(memberWhilePending.status).toBe(200);
      await waitForSlackCall("chat.postMessage", 3);
      expect(
        slackCallsFor("chat.postMessage").at(-1)?.form.get("text"),
      ).toContain("needs to approve me");
      expect(
        await db.turn.count({
          where: { conversation: { agentId: agent.id } },
        }),
      ).toBe(0);

      // ── 3. OWNER approves on the card (signed interactivity). ──
      const decideRes = await postInteractivity({
        type: "block_actions",
        api_app_id: APP_ID,
        user: { id: "U-OWNER" },
        actions: [{ action_id: "reach_approve", value: grant.id }],
        // No response_url: hooks.slack.com is allowlisted by host, so this
        // leg's card rewrite is proven through promptRefs' chat.update.
      });
      expect(decideRes.status).toBe(200);
      const decided = await db.agentReachGrant.findUniqueOrThrow({
        where: { id: grant.id },
      });
      expect(decided.state).toBe("approved");
      expect(decided.decidedByUserId).toBe(OWNER);
      // Every posted owner card was rewritten (the promptRefs pass).
      await waitForSlackCall("chat.update");
      expect(slackCallsFor("chat.update").length).toBeGreaterThan(0);
      // The decision audited under the human who clicked.
      const audit = await db.auditLog.findFirstOrThrow({
        where: { userId: OWNER, action: "approve", service: "channel" },
      });
      expect(audit.metadata).toMatchObject({ reachGrantId: grant.id });

      // ── 4. STRANGER again → a REAL guest turn. ──
      const guestRes = await postEvent({
        type: "app_mention",
        channel: "C-WIRE",
        user: "U-STRANGER",
        text: "<@UBOT> deploy please",
        ts: "200.1",
      });
      expect(guestRes.status).toBe(200);
      const turn = await db.turn.findFirstOrThrow({
        where: { conversation: { agentId: agent.id } },
      });
      expect(turn.userId).toBeNull();
      expect(turn.message).toBe("Dana (guest): <@UBOT> deploy please");
      expect(turn.source).toBe("slack");

      // ── 5. DASHBOARD narrows to members_only (the real PUT). ──
      currentSession = { id: OWNER, email: `${OWNER}@example.com` };
      const revokeRes = await app.request(
        `/v1/agents/${agent.id}/channels/slack/reach/C-WIRE`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-workspace-id": WORKSPACE,
          },
          body: JSON.stringify({ state: "members_only" }),
        },
      );
      expect(revokeRes.status).toBe(200);
      expect(await revokeRes.json()).toMatchObject({
        kind: "decided",
        state: "members_only",
      });
      currentSession = null;

      // ── 6. STRANGER under members_only → the identity refusal. ──
      // Free the one-active-turn slot first so the refusal is the door's.
      await db.turn.updateMany({
        where: { conversation: { agentId: agent.id } },
        data: { status: "done", finishedAt: new Date() },
      });
      const postRevokeRes = await postEvent({
        type: "app_mention",
        channel: "C-WIRE",
        user: "U-STRANGER",
        text: "<@UBOT> still there?",
        ts: "300.1",
      });
      expect(postRevokeRes.status).toBe(200);
      await waitForSlackCall("chat.postMessage", 4);
      const refusal = slackCallsFor("chat.postMessage").at(-1);
      // The identity refusal (not-linked), NOT the waiting line and NOT an
      // answer: the channel is settled, just not open to everyone.
      expect(refusal?.form.get("text")).toContain(
        "couldn't match your Slack account",
      );
      expect(
        await db.turn.count({
          where: {
            conversation: { agentId: agent.id },
            status: { not: "done" },
          },
        }),
      ).toBe(0);

      // ── 7. THE DASHBOARD VIEW carries the space's state (the web's read). ──
      currentSession = { id: OWNER, email: `${OWNER}@example.com` };
      const viewRes = await app.request(`/v1/agents/${agent.id}/channels`, {
        headers: { "x-workspace-id": WORKSPACE },
      });
      expect(viewRes.status).toBe(200);
      const view = (await viewRes.json()) as {
        presences: {
          spaces?: {
            externalRef: string;
            state: string;
            label: string | null;
          }[];
        }[];
      };
      expect(view.presences[0]?.spaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            externalRef: "C-WIRE",
            state: "members_only",
            label: "#proj-wire",
          }),
        ]),
      );
      currentSession = null;

      // ── 8. THE SOCKET ARM's decide door (the adapter's cha_ boundary). ──
      // Re-open through the forwarded-click route, exactly as the channel
      // adapter relays a socket-mode button press.
      const grantRow = await db.agentReachGrant.findUniqueOrThrow({
        where: { id: grant.id },
        select: { id: true },
      });
      const presenceRow = await db.agentChannel.findFirstOrThrow({
        where: { agentId: agent.id },
        select: { id: true },
      });
      await db.channelAdapter.deleteMany({
        where: { token: `cha_${P}wire` },
      });
      await db.channelAdapter.create({
        data: {
          token: `cha_${P}wire`,
          name: `${P}wire-adapter`,
          kind: "anchor",
          lastSeenAt: new Date(),
        },
      });
      const socketDecide = await app.request(
        "/v1/channel-adapter/reach-decision",
        {
          method: "POST",
          headers: {
            authorization: `Bearer cha_${P}wire`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            presenceId: presenceRow.id,
            grantId: grantRow.id,
            // The PRE-RENAME wire word on purpose: an older channel-adapter
            // deployable still sends `approve` during a rolling deploy, and
            // the control plane must keep understanding it.
            decision: "approve",
            clickerExternalUserId: "U-OWNER",
          }),
        },
      );
      expect(socketDecide.status).toBe(200);
      // A settled grant stays settled: a stale card click NEVER re-flips it —
      // exactly what a card left open across a dashboard change must do.
      expect(await socketDecide.json()).toMatchObject({
        kind: "already_settled",
      });
      expect(
        (
          await db.agentReachGrant.findUniqueOrThrow({
            where: { id: grant.id },
          })
        ).state,
      ).toBe("members_only");

      // ── 8b. BLOCKED: the third settlement. The agent goes SILENT in the
      // channel - no answer, no refusal, no turn. Even the linked owner
      // gets nothing, because the setting is about the room. ──
      currentSession = { id: OWNER, email: `${OWNER}@example.com` };
      const blockRes = await app.request(
        `/v1/agents/${agent.id}/channels/slack/reach/C-WIRE`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-workspace-id": WORKSPACE,
          },
          body: JSON.stringify({ state: "blocked" }),
        },
      );
      expect(blockRes.status).toBe(200);
      currentSession = null;

      const postsBeforeBlock = slackCallsFor("chat.postMessage").length;
      const blockedMember = await postEvent({
        type: "app_mention",
        channel: "C-WIRE",
        user: "U-OWNER",
        text: "<@UBOT> anyone home?",
        ts: "400.1",
      });
      expect(blockedMember.status).toBe(200);
      // Nothing said and nothing queued. Asserted after a real settle
      // window so this cannot pass merely by racing the detached poster.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(slackCallsFor("chat.postMessage").length).toBe(postsBeforeBlock);
      expect(
        await db.turn.count({
          where: {
            conversation: { agentId: agent.id },
            status: { not: "done" },
          },
        }),
      ).toBe(0);

      // ── 8c. THE PERSON LANE over the real wire: a stranger's DM knocks,
      // the owner settles it from the DASHBOARD, and the person is then
      // answered as a guest. Proves the routes do not shadow each other -
      // `/reach/:ref` and `/reach/people/:ref` are different doors, and a
      // channel id and a user id are both opaque strings. ──
      slackHandlers["users.info"] = () => ({
        user: {
          id: "U-DM",
          team_id: TEAM,
          name: "sam",
          profile: { display_name: "Sam" },
        },
      });
      const dmRes = await postEvent({
        type: "message",
        channel: "D-SAM",
        channel_type: "im",
        user: "U-DM",
        text: "can you help me?",
        ts: "500.1",
      });
      expect(dmRes.status).toBe(200);
      const personGrant = await db.agentReachGrant.findFirstOrThrow({
        where: { agentId: agent.id, subjectKind: "external_user" },
      });
      expect(personGrant.state).toBe("pending");
      expect(personGrant.externalRef).toBe("U-DM");
      // The space grant is untouched: the two kinds share a table, never a key.
      expect(
        (
          await db.agentReachGrant.findUniqueOrThrow({
            where: { id: grant.id },
          })
        ).subjectKind,
      ).toBe("space");

      // The dashboard's PERSON door (its own path segment).
      currentSession = { id: OWNER, email: `${OWNER}@example.com` };
      const approvePerson = await app.request(
        `/v1/agents/${agent.id}/channels/slack/reach/people/U-DM`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-workspace-id": WORKSPACE,
          },
          body: JSON.stringify({ state: "approved" }),
        },
      );
      expect(approvePerson.status).toBe(200);
      // `members_only` is not a coherent answer about one human, and the
      // schema refuses it rather than storing an unrenderable state.
      const badPerson = await app.request(
        `/v1/agents/${agent.id}/channels/slack/reach/people/U-DM`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-workspace-id": WORKSPACE,
          },
          body: JSON.stringify({ state: "members_only" }),
        },
      );
      expect(badPerson.status).toBe(422);
      currentSession = null;

      // Free the turn slot, then the approved person is answered as a guest.
      await db.turn.updateMany({
        where: { conversation: { agentId: agent.id } },
        data: { status: "done", finishedAt: new Date() },
      });
      const dmAgain = await postEvent({
        type: "message",
        channel: "D-SAM",
        channel_type: "im",
        user: "U-DM",
        text: "thanks!",
        ts: "500.2",
      });
      expect(dmAgain.status).toBe(200);
      const guestTurn = await db.turn.findFirstOrThrow({
        where: {
          conversation: { agentId: agent.id, externalRef: "D-SAM" },
        },
        include: { conversation: true },
      });
      expect(guestTurn.userId).toBeNull();
      expect(guestTurn.message).toBe("Sam (guest): thanks!");
      // The leak fence, asserted on the wire: a guest never lands in the
      // per-user direct row the mirror pushes web activity into.
      expect(guestTurn.conversation.direct).toBe(false);

      // ── 8d. THE VIEW carries the person row to the browser. Without
      // this the whole People section could render empty while every
      // service-level test still passed - the projection is the seam. ──
      currentSession = { id: OWNER, email: `${OWNER}@example.com` };
      const peopleView = await app.request(`/v1/agents/${agent.id}/channels`, {
        headers: { "x-workspace-id": WORKSPACE },
      });
      expect(peopleView.status).toBe(200);
      const withPeople = (await peopleView.json()) as {
        presences: {
          people?: {
            externalRef: string;
            state: string;
            label: string | null;
          }[];
          spaces?: { externalRef: string }[];
        }[];
      };
      expect(withPeople.presences[0]?.people).toEqual([
        expect.objectContaining({
          externalRef: "U-DM",
          state: "approved",
          label: "@Sam",
        }),
      ]);
      // The two kinds stay in their own lists - a person never appears as
      // a channel row, which is the point of the separate sections.
      expect(
        withPeople.presences[0]?.spaces?.some((s) => s.externalRef === "U-DM"),
      ).toBe(false);
      currentSession = null;

      // ── 8e. THE ENCODING CONTRACT. The other legs use tame ids, so
      // they would pass even if the route could not survive a ref needing
      // percent-encoding. The dashboard percent-encodes both segments
      // (apps/web/src/lib/api/channels.ts), so the server must accept what
      // that produces.
      //
      // HONEST SCOPE, so nobody over-trusts this leg: it re-states the
      // client's formula rather than importing it (packages/api must not
      // import from apps/web), so it does NOT pin a rename of the segment
      // on its own - the hand-written legs above already fail first for
      // that. What it uniquely covers is the DECODING behavior: a ref
      // carrying characters that only appear once encoded. ──
      const encodedRef = encodeURIComponent("U/DM+1");
      const browserUrl =
        `/v1/agents/${encodeURIComponent(agent.id)}/channels` +
        `/slack/reach/people/${encodedRef}`;
      // A row whose ref genuinely needs encoding to survive a URL.
      await db.agentReachGrant.create({
        data: {
          agentId: agent.id,
          integrationId: integration.id,
          provider: "slack",
          subjectKind: "external_user",
          externalRef: "U/DM+1",
          state: "pending",
          promptRefs: [],
        },
      });
      currentSession = { id: OWNER, email: `${OWNER}@example.com` };
      const asBrowserPut = await app.request(browserUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-workspace-id": WORKSPACE,
        },
        body: JSON.stringify({ state: "blocked" }),
      });
      expect(asBrowserPut.status).toBe(200);
      // The ref round-tripped: the server decoded back to the exact stored
      // string, not to a mangled or a different row.
      expect(
        (
          await db.agentReachGrant.findFirstOrThrow({
            where: {
              agentId: agent.id,
              subjectKind: "external_user",
              externalRef: "U/DM+1",
            },
          })
        ).state,
      ).toBe("blocked");
      // The OTHER person row is untouched - a slash in a ref must not let
      // one settlement reach a second subject.
      expect(
        (
          await db.agentReachGrant.findFirstOrThrow({
            where: {
              agentId: agent.id,
              subjectKind: "external_user",
              externalRef: "U-DM",
            },
          })
        ).state,
      ).toBe("approved");

      // The dismiss door on the same composed URL.
      const asBrowserDelete = await app.request(browserUrl, {
        method: "DELETE",
        headers: { "x-workspace-id": WORKSPACE },
      });
      expect(asBrowserDelete.status).toBe(200);
      expect(await asBrowserDelete.json()).toMatchObject({
        removedGrant: true,
      });
      // Only the encoded-ref row went; the other person row survives.
      expect(
        await db.agentReachGrant.count({
          where: { agentId: agent.id, subjectKind: "external_user" },
        }),
      ).toBe(1);
      currentSession = null;

      // ── 9. TOKEN-FAMILY negative controls on the same doors. ──
      // The adapter door refuses a non-cha_ bearer (an agent token must
      // never drive the adapter surface)...
      const wrongFamily = await app.request(
        "/v1/channel-adapter/reach-decision",
        {
          method: "POST",
          headers: {
            authorization: `Bearer aoc_${P}agent`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            presenceId: presenceRow.id,
            grantId: grantRow.id,
            decision: "approve",
            clickerExternalUserId: "U-OWNER",
          }),
        },
      );
      expect(wrongFamily.status).toBe(401);
      // ...and the dashboard PUT refuses an unauthenticated caller.
      const noSession = await app.request(
        `/v1/agents/${agent.id}/channels/slack/reach/C-WIRE`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-workspace-id": WORKSPACE,
          },
          body: JSON.stringify({ state: "approved" }),
        },
      );
      expect(noSession.status).toBe(401);
    });
  },
);
