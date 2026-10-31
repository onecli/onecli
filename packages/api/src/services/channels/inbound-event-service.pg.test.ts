import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeSlackServer } from "@onecli/channels/slack/testing";
import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * The provider-neutral events inbox, driven through Slack's events route
 * against a real Postgres and the mounted app: the POST is acknowledged
 * once the event is stored, the event is processed after the ack, and a
 * stored event survives whatever happens to the replica that took it.
 *
 *   - the ack comes back before processing runs, and the row is gone once
 *     it has run;
 *   - Slack's redelivery of an event still in the inbox is absorbed;
 *   - an event a dead replica left behind is recovered once its lease
 *     lapses, and not before;
 *   - two recovery passes never process one event twice;
 *   - a failing event is retried with backoff, then dropped;
 *   - an event another run holds the ingest claim of is retried, not lost;
 *   - an event for a presence that left (detached) is dropped unprocessed;
 *   - expired rows are deleted.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Inbox = typeof import("./inbound-event-service");
let db: Db;
let app: ReturnType<typeof import("../../app").createApiApp>;
let inbox: Inbox;
let slack: FakeSlackServer;

const P = "inbox-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const OWNER = `${P}owner`;
const TEAM = "T0INBOX";
const APP_ID = "A0INBOX";
const SIGNING_SECRET = "inbox-signing";
const SELF_URL = "https://api.inbox.test";

let presenceId: string;

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

/** A DM from a Slack user no account is linked to: the door refuses it with
 * a visible reply, so a processed event leaves a `chat.postMessage` behind. */
const strangerDm = (text: string) => ({
  type: "message",
  channel: "D0INBOX",
  channel_type: "im",
  user: "U0STRANGER",
  text,
  ts: `${Date.now() / 1000}`,
});

const post = (eventId: string, event: unknown) => {
  const raw = JSON.stringify({
    type: "event_callback",
    api_app_id: APP_ID,
    team_id: TEAM,
    event_id: eventId,
    event,
  });
  return app.request("/v1/channels/slack/events", {
    method: "POST",
    headers: signedHeaders(raw),
    body: raw,
  });
};

const inboxRows = () =>
  db.channelInboundEvent.findMany({
    where: { agentChannelId: presenceId },
    orderBy: { createdAt: "asc" },
  });

/** A row as a replica that died mid-event leaves it: claimed, lease lapsed. */
const plantAbandoned = (eventId: string, event: unknown, attempts = 1) =>
  db.channelInboundEvent.create({
    data: {
      agentChannelId: presenceId,
      eventId,
      event: event as object,
      attempts,
      claimToken: "dead-replica",
      claimExpiresAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

const refusals = () => slack.callsTo("chat.postMessage");

beforeAll(async () => {
  if (!PROOF_URL) return;
  const { startFakeSlackServer } =
    await import("@onecli/channels/slack/testing");
  slack = await startFakeSlackServer();
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = slack.url;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

  ({ db } = await import("@onecli/db"));
  const providers = await import("../../providers");
  providers.initSelfUrl(SELF_URL);
  const { createApiApp } = await import("../../app");
  app = createApiApp({ getSession: async () => null }, { selfUrl: SELF_URL });
  inbox = await import("./inbound-event-service");

  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: OWNER } });

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Inbox", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.com`,
      externalAuthId: OWNER,
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: "inbox agent",
      identifier: `${P}agent`,
      accessToken: `aoc_${P}agent`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  const integration = await db.channelIntegration.create({
    data: {
      organizationId: ORG,
      provider: "slack",
      externalId: TEAM,
      name: "Inbox Co",
      createdByUserId: OWNER,
    },
    select: { id: true },
  });
  presenceId = (
    await db.agentChannel.create({
      data: {
        agentId: agent.id,
        integrationId: integration.id,
        provider: "slack",
        externalId: APP_ID,
        identityRef: "UBOT",
        identityName: "inbox",
        transport: "events",
        status: "active",
        credentials: await providers.getCrypto().encrypt(
          JSON.stringify({
            botToken: "xoxb-inbox",
            signingSecret: SIGNING_SECRET,
          }),
        ),
        createdByUserId: OWNER,
      },
      select: { id: true },
    })
  ).id;
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await inbox.settleInboundEventsForTests();
  await db.channelInboundEvent.deleteMany({
    where: { agentChannelId: presenceId },
  });
  await db.agentChannel.update({
    where: { id: presenceId },
    data: { status: "active" },
  });
  slack.calls.length = 0;
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await inbox.settleInboundEventsForTests();
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: OWNER } });
  await slack.close();
});

describe.skipIf(!PROOF_URL)("the Slack events inbox", () => {
  it("acks once the event is stored, processes it after the ack, and clears the row", async () => {
    const res = await post("Ev-inbox-ack", strangerDm("hello"));
    expect(res.status).toBe(200);
    // The ack did not wait for processing: the row is still there, claimed.
    const [stored] = await inboxRows();
    expect(stored).toMatchObject({ eventId: "Ev-inbox-ack", attempts: 1 });
    expect(stored?.claimToken).not.toBeNull();

    await inbox.settleInboundEventsForTests();
    expect(await inboxRows()).toHaveLength(0);
    // The outcome's reply went out from the processing run.
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]?.form.channel).toBe("D0INBOX");
  });

  it("absorbs Slack's redelivery of an event still in the inbox", async () => {
    await plantAbandoned("Ev-inbox-dup", strangerDm("once"));
    // Its lease is still live for this test: a replica is mid-event.
    await db.channelInboundEvent.updateMany({
      where: { agentChannelId: presenceId },
      data: { claimExpiresAt: new Date(Date.now() + 60_000) },
    });

    const res = await post("Ev-inbox-dup", strangerDm("once"));
    expect(res.status).toBe(200);
    await inbox.settleInboundEventsForTests();
    expect(await inboxRows()).toHaveLength(1);
    expect(refusals()).toHaveLength(0);
  });

  it("recovers an event a dead replica left behind, once its lease lapsed and not before", async () => {
    await plantAbandoned("Ev-inbox-live", strangerDm("held"));
    await db.channelInboundEvent.updateMany({
      where: { agentChannelId: presenceId },
      data: { claimExpiresAt: new Date(Date.now() + 60_000) },
    });
    expect(await inbox.recoverInboundEvents()).toBe(0);
    expect(await inboxRows()).toHaveLength(1);

    await db.channelInboundEvent.updateMany({
      where: { agentChannelId: presenceId },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await inbox.recoverInboundEvents()).toBe(1);
    expect(await inboxRows()).toHaveLength(0);
    expect(refusals()).toHaveLength(1);
  });

  it("two concurrent recovery passes process an event exactly once", async () => {
    await plantAbandoned("Ev-inbox-race", strangerDm("race"));
    const [a, b] = await Promise.all([
      inbox.recoverInboundEvents(),
      inbox.recoverInboundEvents(),
    ]);
    expect(a + b).toBe(1);
    expect(refusals()).toHaveLength(1);
  });

  it("retries a failing event with backoff, then drops it after the last attempt", async () => {
    // A failing run: the reply's bot token decrypt fails on a garbled row.
    const original = await db.agentChannel.findUniqueOrThrow({
      where: { id: presenceId },
      select: { credentials: true },
    });
    await db.agentChannel.update({
      where: { id: presenceId },
      data: { credentials: "not-a-ciphertext" },
    });
    try {
      await plantAbandoned("Ev-inbox-fail", strangerDm("boom"));
      expect(await inbox.recoverInboundEvents()).toBe(1);
      const [retrying] = await inboxRows();
      // Released for a later try, not right now.
      expect(retrying?.claimToken).toBeNull();
      expect(retrying?.attempts).toBe(2);
      expect(retrying!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      expect(await inbox.recoverInboundEvents()).toBe(0);

      // The last attempt fails too: the row is gone.
      await db.channelInboundEvent.updateMany({
        where: { agentChannelId: presenceId },
        data: { nextAttemptAt: new Date(Date.now() - 1000), attempts: 4 },
      });
      expect(await inbox.recoverInboundEvents()).toBe(1);
      expect(await inboxRows()).toHaveLength(0);
    } finally {
      await db.agentChannel.update({
        where: { id: presenceId },
        data: { credentials: original.credentials },
      });
    }
  });

  it("retries an event another run still holds the ingest claim of, instead of dropping it", async () => {
    // A live claim on the ledger: the door must not run again, and the
    // inbox must keep the event for a later try (a dead holder's claim
    // lapses, and that later try takes it over).
    await db.channelIngestedEvent.create({
      data: {
        agentChannelId: presenceId,
        eventId: "Ev-inbox-held",
        claimExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await plantAbandoned("Ev-inbox-held", strangerDm("held elsewhere"));
    try {
      expect(await inbox.recoverInboundEvents()).toBe(1);
      const [retrying] = await inboxRows();
      expect(retrying?.claimToken).toBeNull();
      expect(retrying!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      expect(refusals()).toHaveLength(0);
    } finally {
      await db.channelIngestedEvent.deleteMany({
        where: { agentChannelId: presenceId, eventId: "Ev-inbox-held" },
      });
    }
  });

  it("drops an event whose presence was detached after it was accepted, unprocessed", async () => {
    await plantAbandoned("Ev-inbox-detached", strangerDm("too late"));
    await db.agentChannel.update({
      where: { id: presenceId },
      data: { status: "pending_setup" },
    });
    expect(await inbox.recoverInboundEvents()).toBe(1);
    expect(await inboxRows()).toHaveLength(0);
    expect(refusals()).toHaveLength(0);
  });

  it("deletes rows past their retention and rows out of attempts", async () => {
    await plantAbandoned("Ev-inbox-old", strangerDm("old"));
    await plantAbandoned("Ev-inbox-spent", strangerDm("spent"), 5);
    await db.channelInboundEvent.updateMany({
      where: { agentChannelId: presenceId, eventId: "Ev-inbox-old" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await inbox.recoverInboundEvents()).toBe(0);
    expect(await inboxRows()).toHaveLength(0);
    expect(refusals()).toHaveLength(0);
  });
});
