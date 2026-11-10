import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";
import { grantModelKey } from "../../testing/model-key-grant.js";

/**
 * A person's emoji reaction on the agent's own message, end to end over
 * PostgreSQL: the real interpreter, the real dispatch, and the real DM and
 * group doors, against a local recording fake of the Slack Web API.
 *
 * Proven at the level the bugs live: which conversation the note lands in
 * (the DM, a DM thread's own conversation, a joined channel thread), which
 * messages count as the agent's (an icon-posted answer has no `user`; a
 * card and another app's post do not count), and that a reaction never
 * posts a refusal or costs a Slack call it does not need.
 */

const PROOF_URL = proofDatabaseUrl();

const P = "rxnpg-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const MEMBER = `${P}member`;
const TENANT = "T-RXN";
const BOT = "U0RXNBOT";
const MEMBER_SLACK = "U0RXNMEMBER";
const STRANGER_SLACK = "U0RXNSTRANGER";
/** Another agent's bot user in the same workspace. */
const OTHER_BOT = "U0RXNOTHERBOT";
const IM = "D0RXNMEMBER";
const CHANNEL = "C0RXNPROJ";

type Db = typeof import("@onecli/db").db;
type Dispatch = typeof import("./providers/slack/dispatch");

let db: Db;
let dispatch: Dispatch;
let encrypt: (plaintext: string) => Promise<string>;
let integrationId: string;

// ── The fake Slack Web API ──────────────────────────────────────────────────

interface SlackCall {
  method: string;
  form: URLSearchParams;
}

let slackServer: Server;
let slackCalls: SlackCall[] = [];
/** What `conversations.replies` answers, by message ts. */
let messages = new Map<string, Record<string, unknown>>();

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
                messages: [messages.get(form.get("ts") ?? "")].filter(Boolean),
              }
            : method === "users.info"
              ? {
                  ok: true,
                  user: {
                    id: form.get("user"),
                    team_id: TENANT,
                    name: "x",
                    is_bot: form.get("user") === OTHER_BOT,
                  },
                }
              : // The receipt, loader and cards are detached best-effort
                // posts: a refusal costs them, never the turn.
                { ok: false, error: `test_unscripted_${method}` };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

const repliesCalls = () =>
  slackCalls.filter((call) => call.method === "conversations.replies");
const postCalls = () =>
  slackCalls.filter((call) => call.method.startsWith("chat.post"));

// ── Seeds ───────────────────────────────────────────────────────────────────

interface Stage {
  agentId: string;
  presenceId: string;
  appId: string;
}

const seedStage = async (suffix: string): Promise<Stage> => {
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: "Kai",
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  await grantModelKey(db, {
    workspaceId: WORKSPACE,
    agentId: agent.id,
    name: `${P}${suffix}`,
  });
  const appId = `A0RXN${suffix.toUpperCase()}`;
  const presence = await db.agentChannel.create({
    data: {
      agentId: agent.id,
      integrationId,
      provider: "slack",
      externalId: appId,
      identityRef: BOT,
      transport: "socket",
      status: "active",
      credentials: await encrypt(JSON.stringify({ botToken: "xoxb-rxn" })),
    },
    select: { id: true },
  });
  return { agentId: agent.id, presenceId: presence.id, appId };
};

/** The agent's answer as Slack stores one posted with its avatar
 * (`icon_url`): `bot_message`, its app id, and NO `user`. */
const iconAnswer = (stage: Stage, ts: string, text: string, extra = {}) => ({
  ts,
  app_id: stage.appId,
  bot_id: "B0RXN",
  subtype: "bot_message",
  text,
  blocks: [{ type: "rich_text", elements: [] }],
  ...extra,
});

let eventSeq = 0;
const react = (
  stage: Stage,
  item: { channel: string; ts: string; channel_type?: string },
  options: { user?: string; reaction?: string; itemUser?: string } = {},
) =>
  dispatch.dispatchSlackEvent({
    presenceId: stage.presenceId,
    identityRef: BOT,
    event: {
      type: "reaction_added",
      user: options.user ?? MEMBER_SLACK,
      reaction: options.reaction ?? "+1",
      ...(options.itemUser && { item_user: options.itemUser }),
      item: { type: "message", ...item },
    },
    eventId: `Ev-${P}${++eventSeq}`,
  });

/** A typed message in the member's DM, so the direct conversation exists. */
const typeInDm = (stage: Stage, ts: string, threadTs?: string) =>
  dispatch.dispatchSlackEvent({
    presenceId: stage.presenceId,
    identityRef: BOT,
    event: {
      type: "message",
      channel: IM,
      channel_type: "im",
      user: MEMBER_SLACK,
      text: "hello",
      ts,
      ...(threadTs && { thread_ts: threadTs }),
    },
    eventId: `Ev-${P}${++eventSeq}`,
  });

const turnsOf = (agentId: string) =>
  db.turn.findMany({
    where: { conversation: { agentId } },
    orderBy: { createdAt: "asc" },
    select: {
      message: true,
      conversationId: true,
      sourceThreadId: true,
    },
  });

const reset = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
  slackCalls = [];
  messages = new Map();
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  const slackUrl = await startSlackFake();
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = slackUrl;
  // Pinned onprem BEFORE any module import (the channels.pg.test.ts law).
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");

  ({ db } = await import("@onecli/db"));
  const { ensureEditionDefaults } = await import("../../edition-defaults");
  ensureEditionDefaults();
  const { getCrypto } = await import("../../providers");
  encrypt = (plaintext) => getCrypto().encrypt(plaintext);
  dispatch = await import("./providers/slack/dispatch");

  await reset();
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Reactions", organizationId: ORG },
  });
  integrationId = (
    await db.channelIntegration.create({
      data: {
        organizationId: ORG,
        provider: "slack",
        externalId: TENANT,
        name: "RXN Slack",
      },
      select: { id: true },
    })
  ).id;
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
  await db.channelUserLink.create({
    data: {
      integrationId,
      externalUserId: MEMBER_SLACK,
      userId: MEMBER,
      linkedVia: "manual",
    },
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await new Promise<void>((resolve) => slackServer.close(() => resolve()));
});

describe.skipIf(!PROOF_URL)("a reaction on the agent's own message", () => {
  it("in a DM, a 👍 on an icon-posted answer becomes a yes in the person's direct conversation", async () => {
    const stage = await seedStage("dm");
    messages.set("10.1", iconAnswer(stage, "10.1", "Should I send it?\nok"));

    // No `item_user`: Slack omits it for a post no user authored.
    const result = await react(
      stage,
      { channel: IM, ts: "10.1", channel_type: "im" },
      { reaction: "+1::skin-tone-3" },
    );

    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("turn");
    expect(result.call).toEqual({
      door: "reaction",
      replyChannel: IM,
      replyThreadTs: null,
    });
    const [turn] = await turnsOf(stage.agentId);
    expect(turn?.message).toContain(
      ':+1: (read as: yes / approved) to your message: "Should I send it?"',
    );
    const conversation = await db.conversation.findUniqueOrThrow({
      where: { id: turn!.conversationId },
      select: { direct: true, userId: true },
    });
    expect(conversation).toEqual({ direct: true, userId: MEMBER });
    // A reaction is not a typed message: no receipt mark, loader or note.
    expect(slackCalls.map((call) => call.method)).toEqual([
      "conversations.replies",
    ]);
  });

  it("in a DM thread, the note lands in the thread's own conversation, answered in the thread", async () => {
    const stage = await seedStage("dmthread");
    await typeInDm(stage, "20.1");
    await typeInDm(stage, "20.2", "20.1");
    const before = await turnsOf(stage.agentId);
    messages.set(
      "20.3",
      iconAnswer(stage, "20.3", "Done, shall I ship?", { thread_ts: "20.1" }),
    );
    // The agent's TOP-LEVEL answer that heads a thread: Slack gives the
    // parent its own ts as `thread_ts`, yet it belongs to the DM itself.
    messages.set(
      "20.4",
      iconAnswer(stage, "20.4", "Want a summary?", { thread_ts: "20.4" }),
    );

    const inThread = await react(stage, {
      channel: IM,
      ts: "20.3",
      channel_type: "im",
    });
    const onParent = await react(stage, {
      channel: IM,
      ts: "20.4",
      channel_type: "im",
    });

    if (
      inThread.kind !== "message" ||
      !("conversationId" in inThread.outcome) ||
      onParent.kind !== "message" ||
      !("conversationId" in onParent.outcome)
    ) {
      throw new Error("unreachable");
    }
    expect(inThread.call.replyThreadTs).toBe("20.1");
    expect(onParent.call.replyThreadTs).toBeNull();
    // The thread's conversation, never the DM's top level, and the other way
    // round for the parent.
    expect(inThread.outcome.conversationId).toBe(before[1]!.conversationId);
    expect(onParent.outcome.conversationId).toBe(before[0]!.conversationId);
    const notes = await turnsOf(stage.agentId);
    expect(
      notes.find((t) => t.message.includes("Done, shall I ship?")),
    ).toEqual(expect.objectContaining({ sourceThreadId: "20.1" }));
  });

  it("in a channel thread the agent joined, the note enters the thread's conversation", async () => {
    const stage = await seedStage("group");
    // A channel a person approved for the agent (the reach grant every
    // channel message passes), then the agent joins a thread the way it
    // always does: a mention.
    await db.agentReachGrant.create({
      data: {
        agentId: stage.agentId,
        integrationId,
        provider: "slack",
        subjectKind: "space",
        externalRef: CHANNEL,
        state: "approved",
      },
    });
    const mention = await dispatch.dispatchSlackEvent({
      presenceId: stage.presenceId,
      identityRef: BOT,
      event: {
        type: "app_mention",
        channel: CHANNEL,
        user: MEMBER_SLACK,
        text: `<@${BOT}> draft the post`,
        ts: "30.1",
      },
      eventId: `Ev-${P}${++eventSeq}`,
    });
    expect(mention.kind === "message" && mention.outcome.kind).toBe("turn");
    if (mention.kind !== "message" || mention.outcome.kind !== "turn") {
      throw new Error("unreachable");
    }
    messages.set(
      "30.2",
      iconAnswer(stage, "30.2", "Here is a draft. Post it?", {
        thread_ts: "30.1",
      }),
    );

    const result = await react(stage, {
      channel: CHANNEL,
      ts: "30.2",
      channel_type: "channel",
    });

    if (result.kind !== "message") throw new Error("unreachable");
    // The mention's turn has not run yet, so the note joins it as a
    // follow-up: the same rule a typed reply in the thread follows.
    expect(result.outcome.kind).toBe("followUp");
    expect(
      "conversationId" in result.outcome && result.outcome.conversationId,
    ).toBe(mention.outcome.conversationId);
    expect(result.call.replyThreadTs).toBe("30.1");
    expect("turn" in result.outcome && result.outcome.turn.message).toContain(
      "Here is a draft. Post it?",
    );
  });

  it("in a channel the agent never joined a thread of, nothing is read from Slack", async () => {
    const stage = await seedStage("unjoined");
    const result = await react(stage, {
      channel: CHANNEL,
      ts: "40.1",
      channel_type: "channel",
    });
    expect(result).toEqual({
      kind: "ignored",
      reason: "reaction:unjoined-channel",
    });
    expect(repliesCalls()).toEqual([]);
  });

  it("a card, another app's post, the web mirror and a missing message are never the agent's answer", async () => {
    const stage = await seedStage("notmine");
    messages.set(
      "50.1",
      iconAnswer(stage, "50.1", "Approve this?", {
        blocks: [{ type: "section" }, { type: "actions" }],
      }),
    );
    messages.set("50.2", { ...iconAnswer(stage, "50.2", "hi"), app_id: "A0X" });
    messages.set(
      "50.3",
      iconAnswer(stage, "50.3", "_(:globe_with_meridians: · Mia)_ typed"),
    );
    for (const ts of ["50.1", "50.2", "50.3", "50.4"]) {
      expect(
        await react(stage, { channel: IM, ts, channel_type: "im" }),
      ).toEqual({ kind: "ignored", reason: "reaction:not-on-agent-message" });
    }
    expect(await turnsOf(stage.agentId)).toEqual([]);
  });

  it("an answer posted without the avatar (it carries the bot's user id) counts too", async () => {
    const stage = await seedStage("plain");
    messages.set("60.1", {
      ts: "60.1",
      user: BOT,
      bot_id: "B0RXN",
      text: "Want me to book it?",
    });
    const result = await react(
      stage,
      { channel: IM, ts: "60.1", channel_type: "im" },
      { itemUser: BOT },
    );
    expect(result.kind === "message" && result.outcome.kind).toBe("turn");
  });

  it("someone the agent may not answer hears nothing: no refusal is posted", async () => {
    const stage = await seedStage("stranger");
    const strangerIm = `D0${STRANGER_SLACK}`;
    messages.set("70.1", iconAnswer(stage, "70.1", "Hello there"));
    const result = await react(
      stage,
      { channel: strangerIm, ts: "70.1", channel_type: "im" },
      { user: STRANGER_SLACK },
    );
    expect(result).toEqual({ kind: "ignored", reason: "reaction:refused" });
    expect(
      postCalls().filter((call) => call.form.get("channel") === strangerIm),
    ).toEqual([]);
    expect(await turnsOf(stage.agentId)).toEqual([]);
  });

  it("another app's reaction (its own seen mark on our answer) never passes as a person", async () => {
    const stage = await seedStage("appmark");
    // An approved channel opens the room to everyone in it, the widest door
    // a reaction could find: the app must still be refused there.
    await db.agentReachGrant.create({
      data: {
        agentId: stage.agentId,
        integrationId,
        provider: "slack",
        subjectKind: "space",
        externalRef: CHANNEL,
        state: "approved",
      },
    });
    await dispatch.dispatchSlackEvent({
      presenceId: stage.presenceId,
      identityRef: BOT,
      event: {
        type: "app_mention",
        channel: CHANNEL,
        user: MEMBER_SLACK,
        text: `<@${BOT}> hi`,
        ts: "90.1",
      },
      eventId: `Ev-${P}${++eventSeq}`,
    });
    messages.set(
      "90.2",
      iconAnswer(stage, "90.2", "Hi!", { thread_ts: "90.1" }),
    );

    const result = await react(
      stage,
      { channel: CHANNEL, ts: "90.2", channel_type: "channel" },
      { user: OTHER_BOT, reaction: "eyes" },
    );

    expect(result).toEqual({
      kind: "message",
      call: { door: "reaction", replyChannel: CHANNEL, replyThreadTs: "90.1" },
      outcome: { kind: "ignored", reason: "guest-kind-mismatch" },
    });
    expect(await turnsOf(stage.agentId)).toHaveLength(1);
  });

  it("the same reaction delivered twice makes one turn", async () => {
    const stage = await seedStage("dedupe");
    messages.set("80.1", iconAnswer(stage, "80.1", "Ship it?"));
    const event = {
      type: "reaction_added",
      user: MEMBER_SLACK,
      reaction: "white_check_mark",
      item: { type: "message", channel: IM, ts: "80.1", channel_type: "im" },
    };
    const deliver = () =>
      dispatch.dispatchSlackEvent({
        presenceId: stage.presenceId,
        identityRef: BOT,
        event,
        eventId: `Ev-${P}dedupe`,
      });
    await deliver();
    const again = await deliver();
    expect(again.kind === "message" && again.outcome.kind).toBe("duplicate");
    expect(await turnsOf(stage.agentId)).toHaveLength(1);
  });
});
