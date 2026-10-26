import { createHmac } from "node:crypto";
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
import type { FakeSlackServer } from "@onecli/channels/slack/testing";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * Slack's native Stop button over the REAL wire: a person clicks the
 * stop button beside an agent session's "Working…" loader, Slack sends
 * `agent_session_stopped`, and the turn behind that loader is aborted
 * through the same authorized `abortTurn` the web Stop uses, as the person
 * who clicked.
 *
 * Both transports, through their production doors: the signed events route
 * (`/v1/channels/slack/events`, an events-transport app) and the adapter's
 * relay (`/v1/channel-adapter/ingest`, a socket app). Only Slack's own
 * origin is faked (the shared `startFakeSlackServer`).
 *
 * What is pinned, per arm:
 *   - authorized clicker → the turn carries the abort, the session is set
 *     `active` at once, nothing private is posted;
 *   - unlinked / suspended / non-member clicker → nothing aborted, the
 *     loader left standing, a private note in the clicked thread;
 *   - a member clicking on SOMEONE ELSE's direct thread → refused by
 *     `abortTurn`'s own fence, same note;
 *   - the loader's turn already finished → no abort, session settled,
 *     no note, whoever clicked;
 *   - no loader on that thread → settled, nothing else;
 *   - the same event delivered twice → acted on once;
 *   - an address naming another agent's loader → never reached.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;
let getCrypto: typeof import("../providers").getCrypto;
let resetInboundCache: () => void;
let slack: FakeSlackServer;

const P = "stopwire-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}org-other`;
const WORKSPACE = `${P}proj`;
const OWNER = `${P}owner`;
const MEMBER = `${P}member`;
const SUSPENDED = `${P}suspended`;
const STRANGER = `${P}stranger`;
const TEAM = "T0STOPWIRE";
const APP_ID = "A0STOPWIRE";
const SOCKET_APP_ID = "A0STOPSOCK";
const SIGNING_SECRET = "stop-wire-signing";
const SELF_URL = "https://api.stopwire.test";
const BOT_TOKEN = "xoxb-stop-wire";
const SOCKET_BOT_TOKEN = "xoxb-stop-sock";
const ADAPTER_TOKEN = `cha_${P}adapter`;

/** Slack user ids, one per kind of clicker. */
const U_OWNER = "U0OWNER";
const U_MEMBER = "U0MEMBER";
const U_SUSPENDED = "U0SUSP";
const U_STRANGER = "U0STRANGER";
const U_UNLINKED = "U0NOBODY";

const REFUSAL = "You can't stop this agent. Ask its owner.";

const signedHeaders = (rawBody: string) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
};

let eventSeq = 0;
const nextEventId = () => `EvStop${++eventSeq}`;

const stopEvent = (input: {
  user: string;
  channel: string;
  threadTs: string;
}) => ({
  type: "agent_session_stopped",
  channel: input.channel,
  thread_ts: input.threadTs,
  user: input.user,
  event_ts: "1783536983.783769",
  streaming_message_ts: [],
});

/** The events transport: a signed webhook, exactly as Slack posts it. */
const postSignedStop = (
  input: { user: string; channel: string; threadTs: string },
  eventId = nextEventId(),
) => {
  const raw = JSON.stringify({
    type: "event_callback",
    api_app_id: APP_ID,
    team_id: TEAM,
    event_id: eventId,
    event: stopEvent(input),
  });
  return app.request("/v1/channels/slack/events", {
    method: "POST",
    headers: signedHeaders(raw),
    body: raw,
  });
};

/** The socket transport: the adapter relays the event under its cha_ token. */
const relayStop = (
  presenceId: string,
  input: { user: string; channel: string; threadTs: string },
  eventId = nextEventId(),
) =>
  app.request("/v1/channel-adapter/ingest", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADAPTER_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ presenceId, eventId, event: stopEvent(input) }),
  });

let presenceId: string;
let socketPresenceId: string;
let agentId: string;
let socketAgentId: string;
let integrationId: string;

const seedAgent = async (suffix: string) =>
  (
    await db.agent.create({
      data: {
        workspaceId: WORKSPACE,
        name: `stop ${suffix}`,
        identifier: `${P}${suffix}`,
        accessToken: `aoc_${P}${suffix}`,
        kind: "hosted",
        harness: "fake",
      },
      select: { id: true },
    })
  ).id;

/** A running turn with its session loader up on `channel`/`threadTs`. */
const seedLoader = async (input: {
  agentId: string;
  presenceId: string;
  channel: string;
  threadTs: string;
  status?: string;
  direct?: { userId: string };
}) => {
  const conversation = await db.conversation.create({
    data: {
      agentId: input.agentId,
      source: "slack",
      ...(input.direct
        ? { direct: true, userId: input.direct.userId }
        : { externalRef: `${input.channel}:${input.threadTs}` }),
    },
    select: { id: true },
  });
  const turn = await db.turn.create({
    data: {
      conversationId: conversation.id,
      message: "do the long thing",
      status: input.status ?? "running",
      source: "slack",
      ...(input.status === "done" && { finishedAt: new Date() }),
    },
    select: { id: true },
  });
  await db.channelTurnReceipt.create({
    data: {
      turnId: turn.id,
      agentChannelId: input.presenceId,
      channel: input.channel,
      messageTs: input.threadTs,
      kind: "session",
      workStatusSet: true,
    },
  });
  return { turnId: turn.id, conversationId: conversation.id };
};

/** The planted cross-tenant control: a foreign org with its own workspace,
 * agent, integration and presence (per test; `beforeEach` drops them). */
const seedForeignTenant = async () => {
  const foreignWorkspace = `${P}proj-foreign`;
  await db.workspace.upsert({
    where: { id: foreignWorkspace },
    create: {
      id: foreignWorkspace,
      name: "Foreign",
      organizationId: OTHER_ORG,
    },
    update: {},
  });
  const foreignAgent = (
    await db.agent.create({
      data: {
        workspaceId: foreignWorkspace,
        name: "foreign agent",
        identifier: `${P}foreign`,
        accessToken: `aoc_${P}foreign`,
        kind: "hosted",
        harness: "fake",
      },
      select: { id: true },
    })
  ).id;
  const foreignIntegration = await db.channelIntegration.create({
    data: {
      organizationId: OTHER_ORG,
      provider: "slack",
      externalId: "T0FOREIGN",
      name: "Foreign Co",
      createdByUserId: STRANGER,
    },
    select: { id: true },
  });
  const foreignPresence = await db.agentChannel.create({
    data: {
      agentId: foreignAgent,
      integrationId: foreignIntegration.id,
      provider: "slack",
      externalId: "A0FOREIGN",
      identityRef: "U0FOREIGNBOT",
      transport: "socket",
      appMode: "agent",
      status: "active",
      createdByUserId: STRANGER,
    },
    select: { id: true },
  });
  return { agentId: foreignAgent, presenceId: foreignPresence.id };
};

const turnState = (turnId: string) =>
  db.turn.findUniqueOrThrow({
    where: { id: turnId },
    select: { status: true, abortRequested: true },
  });

const statusCalls = () => slack.callsTo("agents.sessions.setStatus");
const ephemerals = () => slack.callsTo("chat.postEphemeral");

/** The detached posts (fireReply) land after the 200; drain them exactly. */
let settle: () => Promise<void>;

beforeAll(async () => {
  if (!PROOF_URL) return;
  const { startFakeSlackServer } =
    await import("@onecli/channels/slack/testing");
  slack = await startFakeSlackServer();
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = slack.url;
  process.env.ANTHROPIC_API_BASE_URL = slack.url;
  process.env.OPENAI_API_BASE_URL = slack.url;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  ({ db } = await import("@onecli/db"));
  const providers = await import("../providers");
  getCrypto = providers.getCrypto;
  providers.initSelfUrl(SELF_URL);
  const { createApiApp } = await import("../app");
  app = createApiApp({ getSession: async () => null }, { selfUrl: SELF_URL });
  settle = (await import("./channel-inbound-slack"))
    .settleDetachedRepliesForTests;
  // The events route caches app id → presence for 60s; every test re-seeds
  // the presence under the same app id, so the cache is reset per test.
  resetInboundCache = (
    await import("../services/channels/providers/slack/inbound-cache")
  ).resetInboundPresenceCacheForTests;

  await dropAll();
  await db.organization.createMany({
    data: [
      { id: ORG, name: ORG, slug: ORG },
      { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
    ],
  });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Stop Wire", organizationId: ORG },
  });
  await db.user.createMany({
    data: [OWNER, MEMBER, SUSPENDED, STRANGER].map((id) => ({
      id,
      email: `${id}@example.com`,
      externalAuthId: id,
    })),
  });
  await db.organizationMember.createMany({
    data: [
      {
        organizationId: ORG,
        userId: OWNER,
        userEmail: `${OWNER}@example.com`,
        role: "owner",
      },
      {
        organizationId: ORG,
        userId: MEMBER,
        userEmail: `${MEMBER}@example.com`,
        role: "member",
      },
      {
        organizationId: ORG,
        userId: SUSPENDED,
        userEmail: `${SUSPENDED}@example.com`,
        role: "member",
        status: "suspended",
        suspendedAt: new Date(),
      },
      // A member of ANOTHER org: linked in this tenant's Slack, but no
      // membership here.
      {
        organizationId: OTHER_ORG,
        userId: STRANGER,
        userEmail: `${STRANGER}@example.com`,
        role: "owner",
      },
    ],
  });
  await db.channelAdapter.create({
    data: {
      token: ADAPTER_TOKEN,
      name: `${P}adapter`,
      kind: "anchor",
      lastSeenAt: new Date(),
    },
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  slack.calls.length = 0;
  resetInboundCache();

  integrationId = (
    await db.channelIntegration.create({
      data: {
        organizationId: ORG,
        provider: "slack",
        externalId: TEAM,
        name: "Stop Wire Co",
        createdByUserId: OWNER,
      },
      select: { id: true },
    })
  ).id;
  await db.channelUserLink.createMany({
    data: [
      {
        integrationId,
        externalUserId: U_OWNER,
        userId: OWNER,
        linkedVia: "manual",
      },
      {
        integrationId,
        externalUserId: U_MEMBER,
        userId: MEMBER,
        linkedVia: "manual",
      },
      {
        integrationId,
        externalUserId: U_SUSPENDED,
        userId: SUSPENDED,
        linkedVia: "manual",
      },
      {
        integrationId,
        externalUserId: U_STRANGER,
        userId: STRANGER,
        linkedVia: "manual",
      },
    ],
  });

  agentId = await seedAgent("events");
  presenceId = (
    await db.agentChannel.create({
      data: {
        agentId,
        integrationId,
        provider: "slack",
        externalId: APP_ID,
        identityRef: "U0BOT",
        transport: "events",
        appMode: "agent",
        status: "active",
        credentials: await getCrypto().encrypt(
          JSON.stringify({
            botToken: BOT_TOKEN,
            signingSecret: SIGNING_SECRET,
          }),
        ),
        createdByUserId: OWNER,
      },
      select: { id: true },
    })
  ).id;

  socketAgentId = await seedAgent("socket");
  socketPresenceId = (
    await db.agentChannel.create({
      data: {
        agentId: socketAgentId,
        integrationId,
        provider: "slack",
        externalId: SOCKET_APP_ID,
        identityRef: "U0BOTSOCK",
        transport: "socket",
        appMode: "agent",
        status: "active",
        credentials: await getCrypto().encrypt(
          JSON.stringify({ botToken: SOCKET_BOT_TOKEN, appToken: "xapp-sock" }),
        ),
        createdByUserId: OWNER,
      },
      select: { id: true },
    })
  ).id;
});

const dropAll = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.channelAdapter.deleteMany({ where: { token: ADAPTER_TOKEN } });
  await db.organizationMember.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
};

afterAll(async () => {
  if (!PROOF_URL) return;
  await dropAll();
  await slack.close();
});

describe.skipIf(!PROOF_URL)(
  "Slack's native Stop over the events transport",
  () => {
    it("an authorized member's click aborts the loader's turn as them and takes the session out of processing at once", async () => {
      const thread = { channel: "C0STOP", threadTs: "1700.0001" };
      const { turnId } = await seedLoader({ agentId, presenceId, ...thread });

      const res = await postSignedStop({ user: U_MEMBER, ...thread });
      expect(res.status).toBe(200);

      // The same abort the web Stop uses: the run is flagged for the runner.
      expect(await turnState(turnId)).toEqual({
        status: "running",
        abortRequested: true,
      });
      // The session left `processing` right away (Slack leaves it to us).
      const set = statusCalls().at(-1)!;
      expect(set.token).toBe(BOT_TOKEN);
      expect(set.form).toMatchObject({
        channel_id: thread.channel,
        thread_ts: thread.threadTs,
        status: "active",
      });
      await settle();
      // Nothing private is owed: the close posts "Stopped." to everyone.
      expect(ephemerals()).toHaveLength(0);
    });

    it("a click on a QUEUED turn (not yet dispatched) cancels it outright", async () => {
      const thread = { channel: "C0STOP", threadTs: "1700.0002" };
      const { turnId } = await seedLoader({
        agentId,
        presenceId,
        ...thread,
        status: "queued",
      });
      expect((await postSignedStop({ user: U_OWNER, ...thread })).status).toBe(
        200,
      );
      expect((await turnState(turnId)).status).toBe("aborted");
    });

    for (const [label, user] of [
      ["an unlinked Slack user (no account match)", U_UNLINKED],
      ["a suspended member", U_SUSPENDED],
      ["a linked user from another org (no membership here)", U_STRANGER],
    ] as const) {
      it(`${label} is refused: nothing stopped, the loader stays, a private note in the thread`, async () => {
        const thread = { channel: "C0STOP", threadTs: `1700.1${user.length}` };
        const { turnId } = await seedLoader({ agentId, presenceId, ...thread });

        expect((await postSignedStop({ user, ...thread })).status).toBe(200);
        await settle();

        expect(await turnState(turnId)).toEqual({
          status: "running",
          abortRequested: false,
        });
        // The loader is the truth (the agent IS still working): untouched.
        expect(statusCalls()).toHaveLength(0);
        const notes = ephemerals();
        expect(notes).toHaveLength(1);
        expect(notes[0]!.token).toBe(BOT_TOKEN);
        expect(notes[0]!.form).toEqual({
          channel: thread.channel,
          user,
          thread_ts: thread.threadTs,
          text: REFUSAL,
        });
      });
    }

    it("a member clicking on SOMEONE ELSE's direct thread is refused by the abort's own fence", async () => {
      // A DM session: the conversation is the owner's private thread. A
      // member who somehow names its address (the event is the provider's,
      // but the address is not a secret) must not stop it.
      const thread = { channel: "D0OWNER", threadTs: "1700.2001" };
      const { turnId } = await seedLoader({
        agentId,
        presenceId,
        ...thread,
        direct: { userId: OWNER },
      });

      expect((await postSignedStop({ user: U_MEMBER, ...thread })).status).toBe(
        200,
      );
      await settle();
      expect(await turnState(turnId)).toEqual({
        status: "running",
        abortRequested: false,
      });
      expect(statusCalls()).toHaveLength(0);
      expect(ephemerals().map((c) => c.form.user)).toEqual([U_MEMBER]);

      // The owner's own click on the same thread works.
      expect((await postSignedStop({ user: U_OWNER, ...thread })).status).toBe(
        200,
      );
      expect((await turnState(turnId)).abortRequested).toBe(true);
    });

    it("a loader whose turn already finished: no abort, the session is settled, no note even for a stranger", async () => {
      const thread = { channel: "C0STOP", threadTs: "1700.3001" };
      const { turnId } = await seedLoader({
        agentId,
        presenceId,
        ...thread,
        status: "done",
      });

      expect(
        (await postSignedStop({ user: U_UNLINKED, ...thread })).status,
      ).toBe(200);
      await settle();
      expect(await turnState(turnId)).toEqual({
        status: "done",
        abortRequested: false,
      });
      expect(statusCalls().map((c) => c.form.status)).toEqual(["active"]);
      expect(ephemerals()).toHaveLength(0);
    });

    it("a thread with no loader of ours is settled and nothing else", async () => {
      const res = await postSignedStop({
        user: U_MEMBER,
        channel: "C0STOP",
        threadTs: "1700.4001",
      });
      expect(res.status).toBe(200);
      await settle();
      expect(statusCalls().map((c) => c.form.status)).toEqual(["active"]);
      expect(ephemerals()).toHaveLength(0);
    });

    it("the same event delivered twice is acted on once", async () => {
      const thread = { channel: "C0STOP", threadTs: "1700.5001" };
      await seedLoader({ agentId, presenceId, ...thread });
      const eventId = nextEventId();

      expect(
        (await postSignedStop({ user: U_MEMBER, ...thread }, eventId)).status,
      ).toBe(200);
      expect(
        (await postSignedStop({ user: U_MEMBER, ...thread }, eventId)).status,
      ).toBe(200);
      expect(statusCalls()).toHaveLength(1);

      // And a refusal is not re-sent on redelivery either.
      const refusedThread = { channel: "C0STOP", threadTs: "1700.5002" };
      await seedLoader({ agentId, presenceId, ...refusedThread });
      const refusedId = nextEventId();
      await postSignedStop({ user: U_UNLINKED, ...refusedThread }, refusedId);
      await postSignedStop({ user: U_UNLINKED, ...refusedThread }, refusedId);
      await settle();
      expect(ephemerals()).toHaveLength(1);
    });

    it("a second click (a new event) after the stop is harmless: the turn is already flagged", async () => {
      const thread = { channel: "C0STOP", threadTs: "1700.6001" };
      const { turnId } = await seedLoader({ agentId, presenceId, ...thread });
      await postSignedStop({ user: U_MEMBER, ...thread });
      const res = await postSignedStop({ user: U_MEMBER, ...thread });
      expect(res.status).toBe(200);
      expect(await turnState(turnId)).toEqual({
        status: "running",
        abortRequested: true,
      });
      await settle();
      expect(ephemerals()).toHaveLength(0);
    });

    it("names only THIS app's loaders: the same address on another agent's app is never reached", async () => {
      // The socket app's loader sits at the exact channel + thread the events
      // app's Stop names. The lookup is per presence, so it stays untouched.
      const thread = { channel: "C0SHARED", threadTs: "1700.7001" };
      const other = await seedLoader({
        agentId: socketAgentId,
        presenceId: socketPresenceId,
        ...thread,
      });

      expect((await postSignedStop({ user: U_OWNER, ...thread })).status).toBe(
        200,
      );
      expect(await turnState(other.turnId)).toEqual({
        status: "running",
        abortRequested: false,
      });
      // Settled on THIS app's token (its own session there, if any), never
      // the other app's.
      expect(statusCalls().map((c) => c.token)).toEqual([BOT_TOKEN]);

      // The fence is the LOOKUP's own, not only the turn query's agent check
      // behind it: the loader index answers per presence.
      const { findSessionTurn } =
        await import("../services/channels/turn-receipt-service");
      expect(await findSessionTurn({ presenceId, ...thread })).toBeNull();
      expect(
        await findSessionTurn({ presenceId: socketPresenceId, ...thread }),
      ).toBe(other.turnId);
    });

    it("never reaches ANOTHER ORG's agent: a foreign tenant's loader at the same address is untouched", async () => {
      // The planted cross-tenant control: a foreign org, its own workspace,
      // agent, integration, presence, and a running turn whose loader sits at
      // the very channel + thread this org's member clicks Stop on.
      const foreignTenant = await seedForeignTenant();
      const thread = { channel: "C0SHARED", threadTs: "1700.8001" };
      const foreign = await seedLoader({ ...foreignTenant, ...thread });

      // Both transports: this org's events app, and this org's socket app.
      expect((await postSignedStop({ user: U_OWNER, ...thread })).status).toBe(
        200,
      );
      expect(
        await (
          await relayStop(socketPresenceId, { user: U_OWNER, ...thread })
        ).json(),
      ).toEqual({ kind: "stop", notice: null });

      expect(await turnState(foreign.turnId)).toEqual({
        status: "running",
        abortRequested: false,
      });
      // Nothing was ever sent on the foreign app's behalf.
      expect(
        statusCalls().every(
          (c) => c.token === BOT_TOKEN || c.token === SOCKET_BOT_TOKEN,
        ),
      ).toBe(true);
    });
  },
);

describe.skipIf(!PROOF_URL)(
  "Slack's native Stop over the socket transport (adapter relay)",
  () => {
    it("an authorized click aborts and settles; the wire tells the adapter nothing is owed", async () => {
      const thread = { channel: "C0SOCK", threadTs: "1800.0001" };
      const { turnId } = await seedLoader({
        agentId: socketAgentId,
        presenceId: socketPresenceId,
        ...thread,
      });

      const res = await relayStop(socketPresenceId, {
        user: U_MEMBER,
        ...thread,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ kind: "stop", notice: null });
      expect((await turnState(turnId)).abortRequested).toBe(true);
      const set = statusCalls().at(-1)!;
      expect(set.token).toBe(SOCKET_BOT_TOKEN);
      expect(set.form.status).toBe("active");
    });

    it("a refused click hands the adapter the private note to post, and nothing is stopped", async () => {
      const thread = { channel: "C0SOCK", threadTs: "1800.0002" };
      const { turnId } = await seedLoader({
        agentId: socketAgentId,
        presenceId: socketPresenceId,
        ...thread,
      });

      const res = await relayStop(socketPresenceId, {
        user: U_UNLINKED,
        ...thread,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        kind: "stop",
        notice: {
          channel: thread.channel,
          threadTs: thread.threadTs,
          user: U_UNLINKED,
          message: REFUSAL,
        },
      });
      expect((await turnState(turnId)).abortRequested).toBe(false);
      expect(statusCalls()).toHaveLength(0);
      // The control plane posts nothing itself on this transport: the
      // adapter holds the socket and posts the note.
      expect(ephemerals()).toHaveLength(0);
    });

    it("a redelivered event is a duplicate on the wire", async () => {
      const thread = { channel: "C0SOCK", threadTs: "1800.0003" };
      await seedLoader({
        agentId: socketAgentId,
        presenceId: socketPresenceId,
        ...thread,
      });
      const eventId = nextEventId();
      await relayStop(socketPresenceId, { user: U_MEMBER, ...thread }, eventId);
      const again = await relayStop(
        socketPresenceId,
        { user: U_MEMBER, ...thread },
        eventId,
      );
      expect(await again.json()).toEqual({ kind: "duplicate" });
      expect(statusCalls()).toHaveLength(1);
    });
  },
);

describe.skipIf(!PROOF_URL)("a regular-flavor app", () => {
  it("never settles a session it cannot have (and still aborts for an authorized click)", async () => {
    await db.agentChannel.update({
      where: { id: presenceId },
      data: { appMode: "regular" },
    });
    const thread = { channel: "C0STOP", threadTs: "1900.0001" };
    const { turnId } = await seedLoader({ agentId, presenceId, ...thread });

    expect((await postSignedStop({ user: U_MEMBER, ...thread })).status).toBe(
      200,
    );
    expect((await turnState(turnId)).abortRequested).toBe(true);
    expect(statusCalls()).toHaveLength(0);
  });
});

// ── The narration card's own Stop (where no native loader stands) ──────────

/** A running turn whose loader is a CARD only (a top-level DM): the session
 * receipt with no native status, and the card posted at `cardTs`. */
const seedCardLoader = async (input: {
  agentId: string;
  presenceId: string;
  channel: string;
  cardTs: string;
  status?: string;
  direct?: { userId: string };
}) => {
  const seeded = await seedLoader({
    agentId: input.agentId,
    presenceId: input.presenceId,
    channel: input.channel,
    threadTs: `root-of-${input.cardTs}`,
    status: input.status,
    direct: input.direct,
  });
  await db.channelTurnReceipt.update({
    where: { turnId: seeded.turnId },
    data: { workStatusSet: false, cardTs: input.cardTs },
  });
  return seeded;
};

const RESPONSE_URL = "https://hooks.slack.com/actions/T0STOPWIRE/1/abc";

/** A signed block_actions click on the card's Stop, exactly as Slack posts
 * it to the interactivity route. `value` is deliberately hostile: it must
 * reach nothing. */
const postCardStopClick = (input: {
  user: string;
  channel: string;
  cardTs: string;
}) => {
  const payload = {
    type: "block_actions",
    api_app_id: APP_ID,
    team: { id: TEAM },
    user: { id: input.user },
    container: {
      type: "message",
      channel_id: input.channel,
      message_ts: input.cardTs,
    },
    channel: { id: input.channel },
    response_url: RESPONSE_URL,
    actions: [{ action_id: "turn_stop", value: "some-other-turn-id" }],
  };
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${raw}`)
    .digest("hex")}`;
  return app.request("/v1/channels/slack/interactivity", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: raw,
  });
};

const relayCardStop = (
  presence: string,
  input: { user: string; channel: string; cardTs: string },
) =>
  app.request("/v1/channel-adapter/card-stop", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADAPTER_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      presenceId: presence,
      channel: input.channel,
      cardTs: input.cardTs,
      clickerExternalUserId: input.user,
    }),
  });

describe.skipIf(!PROOF_URL)(
  "the narration card's own Stop button (a top-level DM: no native loader)",
  () => {
    /** response_url posts (hooks.slack.com only), intercepted; every other
     * fetch (the fake Slack origin) goes through untouched. */
    let responseUrlPosts: { url: string; body: unknown }[];
    beforeEach(() => {
      responseUrlPosts = [];
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).startsWith("https://hooks.slack.com/")) {
          responseUrlPosts.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")),
          });
          return new Response("ok");
        }
        return realFetch(url, init);
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("the owner's click aborts THE CARD'S turn as them; nothing private is posted, no session is touched", async () => {
      const dm = { channel: "D0OWNER", cardTs: "2000.0001" };
      const { turnId } = await seedCardLoader({
        agentId,
        presenceId,
        ...dm,
        direct: { userId: OWNER },
      });

      expect((await postCardStopClick({ user: U_OWNER, ...dm })).status).toBe(
        200,
      );
      expect(await turnState(turnId)).toEqual({
        status: "running",
        abortRequested: true,
      });
      await settle();
      expect(responseUrlPosts).toEqual([]);
      // No native session exists here, so none is moved.
      expect(statusCalls()).toHaveLength(0);
    });

    it("someone without access is refused: private note via response_url, nothing stopped", async () => {
      const dm = { channel: "C0CARD", cardTs: "2000.0002" };
      const { turnId } = await seedCardLoader({ agentId, presenceId, ...dm });

      await postCardStopClick({ user: U_UNLINKED, ...dm });
      await settle();
      expect(await turnState(turnId)).toEqual({
        status: "running",
        abortRequested: false,
      });
      expect(responseUrlPosts).toEqual([
        {
          url: RESPONSE_URL,
          body: {
            replace_original: false,
            response_type: "ephemeral",
            text: REFUSAL,
          },
        },
      ]);
    });

    it("a member pressing Stop on SOMEONE ELSE's DM card is refused by the abort's own fence", async () => {
      const dm = { channel: "D0OWNER", cardTs: "2000.0003" };
      const { turnId } = await seedCardLoader({
        agentId,
        presenceId,
        ...dm,
        direct: { userId: OWNER },
      });
      await postCardStopClick({ user: U_MEMBER, ...dm });
      await settle();
      expect((await turnState(turnId)).abortRequested).toBe(false);
      expect(responseUrlPosts).toHaveLength(1);
    });

    it("a click on a card whose turn already ended, or on a message that is no card of ours, is a quiet no-op", async () => {
      const done = { channel: "D0OWNER", cardTs: "2000.0004" };
      const { turnId } = await seedCardLoader({
        agentId,
        presenceId,
        ...done,
        status: "done",
        direct: { userId: OWNER },
      });
      await postCardStopClick({ user: U_UNLINKED, ...done });
      await postCardStopClick({
        user: U_OWNER,
        channel: "D0OWNER",
        cardTs: "9999.9999",
      });
      await settle();
      expect((await turnState(turnId)).status).toBe("done");
      expect(responseUrlPosts).toEqual([]);
    });

    it("the card address never reaches a NATIVE loader's turn (the thread root is not a card)", async () => {
      // A channel thread's native loader at root 2000.0005: a forged card
      // click naming that root as the card ts must not stop it.
      const thread = { channel: "C0STOP", threadTs: "2000.0005" };
      const { turnId } = await seedLoader({ agentId, presenceId, ...thread });
      await postCardStopClick({
        user: U_OWNER,
        channel: thread.channel,
        cardTs: thread.threadTs,
      });
      expect((await turnState(turnId)).abortRequested).toBe(false);
    });

    it("never reaches ANOTHER ORG's card at the same address, on either door", async () => {
      const dm = { channel: "D0SHAREDORG", cardTs: "2000.0009" };
      const foreign = await seedCardLoader({
        ...(await seedForeignTenant()),
        ...dm,
      });
      await postCardStopClick({ user: U_OWNER, ...dm });
      expect(
        await (
          await relayCardStop(socketPresenceId, { user: U_OWNER, ...dm })
        ).json(),
      ).toEqual({ kind: "idle" });
      expect(await turnState(foreign.turnId)).toEqual({
        status: "running",
        abortRequested: false,
      });
    });

    it("never reaches another app's card at the same address (per presence)", async () => {
      const dm = { channel: "D0SHARED", cardTs: "2000.0006" };
      const other = await seedCardLoader({
        agentId: socketAgentId,
        presenceId: socketPresenceId,
        ...dm,
      });
      await postCardStopClick({ user: U_OWNER, ...dm });
      expect((await turnState(other.turnId)).abortRequested).toBe(false);
    });

    it("socket transport: the relay stops the card's turn, and a refusal comes back for the adapter to post", async () => {
      const dm = { channel: "D0SOCK", cardTs: "2000.0007" };
      const { turnId } = await seedCardLoader({
        agentId: socketAgentId,
        presenceId: socketPresenceId,
        ...dm,
      });

      const refused = await relayCardStop(socketPresenceId, {
        user: U_UNLINKED,
        ...dm,
      });
      expect(refused.status).toBe(200);
      expect(await refused.json()).toEqual({
        kind: "refused",
        message: REFUSAL,
      });
      expect((await turnState(turnId)).abortRequested).toBe(false);

      const stopped = await relayCardStop(socketPresenceId, {
        user: U_MEMBER,
        ...dm,
      });
      expect(await stopped.json()).toEqual({ kind: "stopped" });
      expect((await turnState(turnId)).abortRequested).toBe(true);

      // A second click: the turn is still running (flagged), so it is a
      // harmless re-request, never an error.
      const again = await relayCardStop(socketPresenceId, {
        user: U_MEMBER,
        ...dm,
      });
      expect(await again.json()).toEqual({ kind: "stopped" });
    });

    it("the relay refuses an unknown field and a wrong-family token", async () => {
      const unknown = await app.request("/v1/channel-adapter/card-stop", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ADAPTER_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          presenceId: socketPresenceId,
          channel: "D0SOCK",
          cardTs: "2000.0008",
          clickerExternalUserId: U_OWNER,
          turnId: "smuggled",
        }),
      });
      expect(unknown.status).toBe(422);
      const wrongFamily = await app.request("/v1/channel-adapter/card-stop", {
        method: "POST",
        headers: {
          authorization: `Bearer aoc_${P}socket`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          presenceId: socketPresenceId,
          channel: "D0SOCK",
          cardTs: "2000.0008",
          clickerExternalUserId: U_OWNER,
        }),
      });
      expect(wrongFamily.status).toBe(401);
    });
  },
);

// ── A waiting message's Send now, on the same card ─────────────────────────

/** A message sent while the card's turn works, not read yet: a follow-up of
 * that turn, by `userId`. `delivered` = already handed to the run (the only
 * state in which a Send now reaches the sandbox). */
const seedWaiting = async (input: {
  conversationId: string;
  turnId: string;
  userId: string | null;
  status?: string;
}) =>
  (
    await db.turn.create({
      data: {
        conversationId: input.conversationId,
        followUpOfTurnId: input.turnId,
        message: "what's in this picture?",
        status: input.status ?? "joining",
        source: "slack",
        userId: input.userId,
        steerDeliveredAt: new Date(),
      },
      select: { id: true },
    })
  ).id;

const sendNowRequested = async (followUpId: string) =>
  (
    await db.turn.findUniqueOrThrow({
      where: { id: followUpId },
      select: { sendNowRequested: true },
    })
  ).sendNowRequested;

/** A signed click on a waiting row's Send now, exactly as Slack posts it. */
const postSendNowClick = (input: {
  user: string;
  channel: string;
  cardTs: string;
  followUpId: string;
}) => {
  const payload = {
    type: "block_actions",
    api_app_id: APP_ID,
    team: { id: TEAM },
    user: { id: input.user },
    container: {
      type: "message",
      channel_id: input.channel,
      message_ts: input.cardTs,
    },
    channel: { id: input.channel },
    response_url: RESPONSE_URL,
    actions: [{ action_id: "follow_up_send_now", value: input.followUpId }],
  };
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${raw}`)
    .digest("hex")}`;
  return app.request("/v1/channels/slack/interactivity", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: raw,
  });
};

const relaySendNow = (
  presence: string,
  input: { user: string; channel: string; cardTs: string; followUpId: string },
) =>
  app.request("/v1/channel-adapter/card-follow-up-action", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADAPTER_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      presenceId: presence,
      channel: input.channel,
      cardTs: input.cardTs,
      clickerExternalUserId: input.user,
      action: "send_now",
      followUpId: input.followUpId,
    }),
  });

const NOT_YOURS = "Only the person who sent this message can do that.";
const GONE =
  "That message isn't waiting anymore: the agent already read it, or the task ended.";

describe.skipIf(!PROOF_URL)(
  "Send now on a waiting message's row of the card (both transports)",
  () => {
    let responseUrlPosts: { url: string; body: unknown }[];
    beforeEach(() => {
      responseUrlPosts = [];
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).startsWith("https://hooks.slack.com/")) {
          responseUrlPosts.push({
            url: String(url),
            body: JSON.parse(String(init?.body ?? "{}")),
          });
          return new Response("ok");
        }
        return realFetch(url, init);
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const privateNote = (text: string) => ({
      url: RESPONSE_URL,
      body: { replace_original: false, response_type: "ephemeral", text },
    });

    it("the AUTHOR's click asks the agent to read it now, as them; nothing private is posted", async () => {
      const card = { channel: "C0ROW", cardTs: "3000.0001" };
      const seeded = await seedCardLoader({ agentId, presenceId, ...card });
      const followUpId = await seedWaiting({ ...seeded, userId: MEMBER });

      const res = await postSendNowClick({
        user: U_MEMBER,
        ...card,
        followUpId,
      });
      expect(res.status).toBe(200);
      await settle();
      expect(await sendNowRequested(followUpId)).toBe(true);
      expect(responseUrlPosts).toEqual([]);
    });

    it("a MEMBER who is not the author is refused, privately, and nothing is asked", async () => {
      // MUTATION-PROOF: drop the author check in `actOnCardFollowUp` and
      // this fails: anyone in the thread could rush someone else's message.
      const card = { channel: "C0ROW", cardTs: "3000.0002" };
      const seeded = await seedCardLoader({ agentId, presenceId, ...card });
      const followUpId = await seedWaiting({ ...seeded, userId: MEMBER });

      await postSendNowClick({ user: U_OWNER, ...card, followUpId });
      await settle();
      expect(await sendNowRequested(followUpId)).toBe(false);
      expect(responseUrlPosts).toEqual([privateNote(NOT_YOURS)]);
    });

    const NOT_LINKED =
      "I couldn't match your Slack account to a OneCLI user, so I can't help here yet. Ask an org admin to link your account under the organization's Channels settings.";
    const NO_ACCESS =
      "Your OneCLI account doesn't have access to my workspace, so I can't help here. Ask a workspace admin to grant you access in the dashboard.";

    it.each([
      ["an unlinked person", U_UNLINKED, NOT_LINKED],
      ["a suspended member", U_SUSPENDED, NO_ACCESS],
      ["another org's member", U_STRANGER, NO_ACCESS],
    ])(
      "%s is refused as a speaker first, and nothing is asked",
      async (_label, user, refusal) => {
        // MUTATION-PROOF: drop the speaker check in `actOnCardFollowUp` and
        // this fails: the author check would refuse instead, with a sentence
        // that tells a stranger nothing true about why.
        const card = { channel: "C0ROW", cardTs: "3000.0003" };
        const seeded = await seedCardLoader({ agentId, presenceId, ...card });
        const followUpId = await seedWaiting({ ...seeded, userId: MEMBER });

        await postSendNowClick({ user, ...card, followUpId });
        await settle();
        expect(await sendNowRequested(followUpId)).toBe(false);
        expect(responseUrlPosts).toEqual([privateNote(refusal)]);
      },
    );

    it("a message the agent already read, or one whose task ended, says so privately", async () => {
      const card = { channel: "C0ROW", cardTs: "3000.0004" };
      const seeded = await seedCardLoader({ agentId, presenceId, ...card });
      const read = await seedWaiting({
        ...seeded,
        userId: MEMBER,
        status: "joined",
      });
      await postSendNowClick({ user: U_MEMBER, ...card, followUpId: read });

      const ended = { channel: "C0ROW", cardTs: "3000.0005" };
      const finished = await seedCardLoader({
        agentId,
        presenceId,
        ...ended,
        status: "done",
      });
      const late = await seedWaiting({ ...finished, userId: MEMBER });
      await postSendNowClick({ user: U_MEMBER, ...ended, followUpId: late });

      await settle();
      expect(await sendNowRequested(read)).toBe(false);
      expect(await sendNowRequested(late)).toBe(false);
      expect(responseUrlPosts).toEqual([
        privateNote(GONE),
        privateNote("The agent finished before it could read this message"),
      ]);
    });

    it("the row id is a pointer, never an authority: a message of ANOTHER card is unreachable from this one", async () => {
      // MUTATION-PROOF: drop `followUpOfTurnId: cardTurnId` from the lookup
      // and this fails: a forged value would reach any waiting message.
      const mine = { channel: "C0ROW", cardTs: "3000.0006" };
      await seedCardLoader({ agentId, presenceId, ...mine });
      const other = { channel: "C0OTHER", cardTs: "3000.0007" };
      const seeded = await seedCardLoader({ agentId, presenceId, ...other });
      const followUpId = await seedWaiting({ ...seeded, userId: MEMBER });

      await postSendNowClick({ user: U_MEMBER, ...mine, followUpId });
      await settle();
      expect(await sendNowRequested(followUpId)).toBe(false);
      expect(responseUrlPosts).toEqual([privateNote(GONE)]);
    });

    it("never reaches ANOTHER ORG's or another app's message at the same card address, on either door", async () => {
      const card = { channel: "D0SHAREDROW", cardTs: "3000.0008" };
      const foreign = await seedCardLoader({
        ...(await seedForeignTenant()),
        ...card,
      });
      const foreignFollowUp = await seedWaiting({
        ...foreign,
        userId: STRANGER,
      });
      const otherApp = await seedCardLoader({
        agentId: socketAgentId,
        presenceId: socketPresenceId,
        channel: "D0SHAREDROW",
        cardTs: "3000.0009",
      });
      const otherAppFollowUp = await seedWaiting({
        ...otherApp,
        userId: MEMBER,
      });

      await postSendNowClick({
        user: U_STRANGER,
        ...card,
        followUpId: foreignFollowUp,
      });
      await postSendNowClick({
        user: U_MEMBER,
        channel: "D0SHAREDROW",
        cardTs: "3000.0009",
        followUpId: otherAppFollowUp,
      });
      expect(
        await (
          await relaySendNow(socketPresenceId, {
            user: U_STRANGER,
            ...card,
            followUpId: foreignFollowUp,
          })
        ).json(),
      ).toEqual({ kind: "refused", message: GONE });
      await settle();
      expect(await sendNowRequested(foreignFollowUp)).toBe(false);
      expect(await sendNowRequested(otherAppFollowUp)).toBe(false);
    });

    it("socket transport: the relay asks for the author, and a refusal comes back for the adapter to post", async () => {
      const card = { channel: "D0SOCKROW", cardTs: "3000.0010" };
      const seeded = await seedCardLoader({
        agentId: socketAgentId,
        presenceId: socketPresenceId,
        ...card,
      });
      const followUpId = await seedWaiting({ ...seeded, userId: MEMBER });

      const refused = await relaySendNow(socketPresenceId, {
        user: U_OWNER,
        ...card,
        followUpId,
      });
      expect(refused.status).toBe(200);
      expect(await refused.json()).toEqual({
        kind: "refused",
        message: NOT_YOURS,
      });
      expect(await sendNowRequested(followUpId)).toBe(false);

      const done = await relaySendNow(socketPresenceId, {
        user: U_MEMBER,
        ...card,
        followUpId,
      });
      expect(await done.json()).toEqual({ kind: "done" });
      expect(await sendNowRequested(followUpId)).toBe(true);
    });

    it("the relay refuses an unknown action, an unknown field, and a wrong-family token", async () => {
      const body = {
        presenceId: socketPresenceId,
        channel: "D0SOCKROW",
        cardTs: "3000.0011",
        clickerExternalUserId: U_MEMBER,
        action: "send_now",
        followUpId: "fu-x",
      };
      const post = (payload: unknown, token = ADAPTER_TOKEN) =>
        app.request("/v1/channel-adapter/card-follow-up-action", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      expect(
        (await post({ ...body, action: "delete_everything" })).status,
      ).toBe(422);
      expect((await post({ ...body, turnId: "smuggled" })).status).toBe(422);
      expect((await post(body, `aoc_${P}socket`)).status).toBe(401);
    });
  },
);
