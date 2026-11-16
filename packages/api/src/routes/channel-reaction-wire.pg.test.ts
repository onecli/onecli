import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";
import { grantModelKey } from "../testing/model-key-grant.js";

/**
 * A reaction on the agent's own answer, over the REAL production wire: the
 * mounted api app, a Slack-signature-verified `reaction_added` on
 * POST /v1/channels/slack/events, the durable inbox, the dispatch, and the
 * DM door. Only Slack's own origin is faked.
 *
 * The case that matters most: an answer posted with the agent's avatar, as
 * Slack stores it (`bot_message`, the app id, NO `user`) and as Slack
 * announces a reaction on it (NO `item_user`). That is how every answer of
 * an agent with an avatar arrives on a public deployment.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;
let settleInbound: () => Promise<void>;
let getCrypto: typeof import("../providers").getCrypto;

const P = "rxnwire-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const MEMBER = `${P}member`;
const TEAM = "T-RXN-WIRE";
const APP_ID = "A0RXNWIRE";
const BOT = "U0RXNWIREBOT";
const MEMBER_SLACK = "U0RXNWIREMEM";
const IM = "D0RXNWIREMEM";
const SIGNING_SECRET = "rxn-wire-signing";
const SELF_URL = "https://api.rxnwire.test";

// ── Fake Slack origin ───────────────────────────────────────────────────────

let slackServer: Server;
const slackCalls: { method: string; form: URLSearchParams }[] = [];
/** The agent's own answer, as conversations.replies returns it. */
const ANSWER = {
  ts: "500.1",
  app_id: APP_ID,
  bot_id: "B0RXNWIRE",
  subtype: "bot_message",
  text: "Draft is ready. Should I send it?",
  blocks: [{ type: "rich_text", elements: [] }],
};

const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        const method = (req.url ?? "/").slice(1);
        const form = new URLSearchParams(raw);
        slackCalls.push({ method, form });
        const body =
          method === "conversations.replies"
            ? {
                ok: true,
                messages: form.get("ts") === ANSWER.ts ? [ANSWER] : [],
              }
            : { ok: false, error: `test_unscripted_${method}` };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

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
/** A signed event on the production door, then the inbox run it started. */
const postEvent = async (event: unknown) => {
  eventSeq += 1;
  const raw = JSON.stringify({
    type: "event_callback",
    api_app_id: APP_ID,
    event_id: `EvRxnWire${eventSeq}`,
    event,
  });
  const res = await app.request("/v1/channels/slack/events", {
    method: "POST",
    headers: signedHeaders(raw),
    body: raw,
  });
  await settleInbound();
  return res;
};

const cleanup = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
  await db.workspaceAccess.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
};

let agentId: string;

beforeAll(async () => {
  if (!PROOF_URL) return;
  const slackUrl = await startSlackFake();
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = slackUrl;
  // Pinned onprem BEFORE any module import (the channels.pg.test.ts law).
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  // The shared fake key: fleet-wide readers in sibling suites decrypt every
  // presence's credentials.
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  ({ db } = await import("@onecli/db"));
  const providers = await import("../providers");
  getCrypto = providers.getCrypto;
  providers.initSelfUrl(SELF_URL);
  const { createApiApp } = await import("../app");
  app = createApiApp({ getSession: async () => null }, { selfUrl: SELF_URL });
  settleInbound = (await import("../services/channels/inbound-event-service"))
    .settleInboundEventsForTests;

  await cleanup();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Reaction Wire", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: MEMBER,
      email: `${MEMBER}@example.com`,
      externalAuthId: MEMBER,
      name: "Mia Member",
    },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: MEMBER,
      userEmail: `${MEMBER}@example.com`,
      role: "member",
    },
  });
  await db.workspaceAccess.create({
    data: { workspaceId: WORKSPACE, userId: MEMBER, role: "member" },
  });
  agentId = (
    await db.agent.create({
      data: {
        workspaceId: WORKSPACE,
        name: "Kai",
        identifier: `${P}agent`,
        accessToken: `aoc_${P}agent`,
        kind: "hosted",
        harness: "fake",
      },
      select: { id: true },
    })
  ).id;
  await grantModelKey(db, { workspaceId: WORKSPACE, agentId, name: `${P}key` });
  const integration = await db.channelIntegration.create({
    data: {
      organizationId: ORG,
      provider: "slack",
      externalId: TEAM,
      name: "Reaction Wire Co",
    },
    select: { id: true },
  });
  await db.agentChannel.create({
    data: {
      agentId,
      integrationId: integration.id,
      provider: "slack",
      externalId: APP_ID,
      identityRef: BOT,
      transport: "events",
      status: "active",
      credentials: await getCrypto().encrypt(
        JSON.stringify({
          botToken: "xoxb-rxn-wire",
          signingSecret: SIGNING_SECRET,
        }),
      ),
    },
  });
  await db.channelUserLink.create({
    data: {
      integrationId: integration.id,
      externalUserId: MEMBER_SLACK,
      userId: MEMBER,
      linkedVia: "manual",
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await cleanup();
  await new Promise<void>((resolve) => slackServer.close(() => resolve()));
});

describe.skipIf(!PROOF_URL)("a reaction over the real events wire", () => {
  it("a 👍 on the agent's icon-posted answer becomes a yes turn in the person's DM; a malformed one is acked and dropped", async () => {
    // As Slack sends it: no `item_user`, because no user authored the post.
    const res = await postEvent({
      type: "reaction_added",
      user: MEMBER_SLACK,
      reaction: "+1::skin-tone-2",
      item: { type: "message", channel: IM, ts: ANSWER.ts, channel_type: "im" },
      event_ts: "500.2",
    });
    expect(res.status).toBe(200);

    const turns = await db.turn.findMany({
      where: { conversation: { agentId } },
      select: { message: true, conversation: { select: { direct: true } } },
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.conversation.direct).toBe(true);
    expect(turns[0]!.message).toContain(
      ':+1: (read as: yes / approved) to your message: "Draft is ready. Should I send it?"',
    );
    // The message was re-read with the presence's own bot token.
    const reads = slackCalls.filter(
      (c) => c.method === "conversations.replies",
    );
    expect(reads.map((c) => [c.form.get("channel"), c.form.get("ts")])).toEqual(
      [[IM, ANSWER.ts]],
    );

    // A malformed reaction (no item) is acked like any event and creates
    // nothing: no 500 for Slack to retry, no inbox row left behind.
    const bad = await postEvent({
      type: "reaction_added",
      user: MEMBER_SLACK,
      reaction: "+1",
    });
    expect(bad.status).toBe(200);
    expect(await db.turn.count({ where: { conversation: { agentId } } })).toBe(
      1,
    );
    expect(
      await db.channelInboundEvent.count({
        where: { agentChannel: { agentId } },
      }),
    ).toBe(0);
  });
});
