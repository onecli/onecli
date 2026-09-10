import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../../testing/pg-proof.js";

/**
 * App conversations, inbound (PR 5a) — proofs against a real DB and a fake
 * Slack:
 *
 *  - an app's mention in an APPROVED channel is admitted as a guest turn,
 *    framed `Name (app):`, `userId` null, and the streak counts it;
 *  - in a `members_only` channel an app is ignored SILENTLY (no refusal
 *    text — an answer to an app is a loop seed);
 *  - the directory must AGREE the speaker is an app (`is_bot`) — a wire
 *    claim the probe contradicts is dropped, both ways;
 *  - the blocked-person precedence law applies to an app's ref;
 *  - THE CHAIN: six app turns admit, the seventh is the pause (one refusal
 *    line + exactly one pending lift approval), the eighth is silence;
 *  - a human turn resets the streak; the next app turn admits again;
 *  - approving the lift flips the thread unlimited AND replays the parked
 *    message as a turn — nobody types; further app turns admit;
 *  - the dashboard Pause revokes the lift (streak reset), fenced by
 *    workspace and agent;
 *  - COUNT ON LANDING: a message that never became a turn costs no streak
 *    point; the crossing stays exactly once under two concurrent messages;
 *  - VERIFY AT REPLAY: approving a stale card refuses when the channel
 *    closed or the app was blocked after the card - nothing resumes, no
 *    turn, the approval settles failed with the reason;
 *  - HEARD WHEN TAGGED: an app's un-tagged thread reply is ignored before
 *    the door (a person's still admits);
 *  - THE ROOM'S APPS ARE TAGGABLE: a new thread is seeded with the channel's
 *    app members (never the agent's own bot user, never a name that shadows
 *    a linked human), so @[Name] resolves from the FIRST turn and the
 *    context note lists it.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Dispatch = typeof import("./providers/slack/dispatch");
type Reach = typeof import("./agent-reach-service");
type Cap = typeof import("./app-turn-cap-service");
type Approvals = typeof import("./action-approval-service");
type Mentions = typeof import("./mention-resolution-service");
type Providers = typeof import("../../providers");

let db: Db;
let dispatch: Dispatch;
let reach: Reach;
let cap: Cap;
let approvals: Approvals;
let mentions: Mentions;
let getCrypto: Providers["getCrypto"];

const P = "appcv-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OWNER = `${P}owner`;
const TENANT = "T-APPCV";
const BOT = "UBOTAPPCV";
const APP_USER = "U-GUYDEV";
const APP_BOT_ID = "B-GUYDEV";
const HUMAN = "U-HUMAN";
const CHANNEL = "C-PRIV";

interface SlackCall {
  method: string;
  form: URLSearchParams;
}
let slackServer: Server;
let slackCalls: SlackCall[] = [];
let slackHandlers: Record<string, (call: SlackCall) => unknown> = {};
const slackCallsFor = (method: string) =>
  slackCalls.filter((c) => c.method === method);

const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        const method = (req.url ?? "/").slice(1);
        const call: SlackCall = { method, form: new URLSearchParams(raw) };
        slackCalls.push(call);
        const handler = slackHandlers[method];
        const body = handler
          ? handler(call)
          : { ok: false, error: `test_unscripted_${method}` };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...(body as object) }));
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

/** The directory the probe reads: one app bot user, one human. */
const scriptDirectory = () => {
  slackHandlers["users.info"] = (call) => {
    const user = call.form.get("user");
    return user === APP_USER
      ? {
          user: {
            id: user,
            team_id: TENANT,
            name: "guy-dev",
            is_bot: true,
            profile: { display_name: "guy-dev" },
          },
        }
      : {
          user: {
            id: user,
            team_id: TENANT,
            name: "dana",
            profile: { display_name: "Dana" },
          },
        };
  };
  slackHandlers["conversations.info"] = (call) => ({
    channel: { id: call.form.get("channel"), name: "guy-private" },
  });
  // The room's roster: the app, a human, the agent's OWN bot user, Slackbot.
  slackHandlers["conversations.members"] = () => ({
    members: [APP_USER, HUMAN, BOT, "USLACKBOT"],
  });
  // The workspace directory the roster is intersected with (carries is_bot).
  slackHandlers["users.list"] = () => ({
    members: [
      {
        id: APP_USER,
        team_id: TENANT,
        name: "guy-dev",
        is_bot: true,
        profile: { display_name: "guy-dev" },
      },
      {
        id: HUMAN,
        team_id: TENANT,
        name: "dana",
        profile: { display_name: "Dana" },
      },
      { id: BOT, team_id: TENANT, name: "donna", is_bot: true },
      { id: "USLACKBOT", team_id: TENANT, name: "slackbot" },
    ],
  });
  slackHandlers["conversations.open"] = () => ({
    channel: { id: "D-OWNER-IM" },
  });
  slackHandlers["chat.postMessage"] = () => ({
    channel: "D-OWNER-IM",
    ts: "777.111",
  });
  slackHandlers["chat.update"] = () => ({ ts: "777.111" });
};

// ── Seeds ───────────────────────────────────────────────────────────────────

const grantLlmKey = async (agentId: string, suffix: string) => {
  const secret = await db.secret.create({
    data: {
      scope: "workspace",
      workspaceId: WORKSPACE,
      name: `${P}${suffix}`,
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
      logicalId: `${P}${suffix}`,
      name: `${P}${suffix}`,
      action: "allow",
      requireApproval: false,
      identities: { create: [{ agentId }] },
      targets: { create: [{ kind: "secret", secretId: secret.id }] },
    },
  });
};

const seedIntegration = async () =>
  (await db.channelIntegration.findFirst({
    where: { organizationId: ORG, provider: "slack" },
    select: { id: true },
  })) ??
  db.channelIntegration.create({
    data: {
      organizationId: ORG,
      provider: "slack",
      externalId: TENANT,
      name: "AppCv Co",
      credentials: null,
      createdByUserId: OWNER,
    },
    select: { id: true },
  });

/** An agent with an active presence in an APPROVED (or given-state) channel. */
const seedStage = async (
  suffix: string,
  channelState: "approved" | "members_only" = "approved",
) => {
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `Donna ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  await grantLlmKey(agent.id, suffix);
  const integration = await seedIntegration();
  const presence = await db.agentChannel.create({
    data: {
      agentId: agent.id,
      integrationId: integration.id,
      provider: "slack",
      externalId: `A-${agent.id.slice(0, 8)}`,
      identityRef: BOT,
      transport: "socket",
      status: "active",
      credentials: await getCrypto().encrypt(
        JSON.stringify({ botToken: "xoxb-appcv" }),
      ),
      createdByUserId: OWNER,
    },
    select: { id: true },
  });
  await reach.ensureSpaceGrant({
    agentId: agent.id,
    integrationId: integration.id,
    provider: "slack",
    externalRef: CHANNEL,
  });
  await db.agentReachGrant.updateMany({
    where: { agentId: agent.id },
    data: { state: channelState },
  });
  // The owner is DM-reachable, so the lift card has a target.
  await db.channelUserLink.upsert({
    where: {
      integrationId_externalUserId: {
        integrationId: integration.id,
        externalUserId: "U-OWNER",
      },
    },
    create: {
      integrationId: integration.id,
      externalUserId: "U-OWNER",
      userId: OWNER,
      linkedVia: "manual",
    },
    update: {},
  });
  return {
    agentId: agent.id,
    integrationId: integration.id,
    presenceId: presence.id,
  };
};

let evSeq = 0;
const appMention = (threadTs: string, text: string) => ({
  type: "app_mention",
  channel: CHANNEL,
  user: APP_USER,
  bot_id: APP_BOT_ID,
  text: `<@${BOT}> ${text}`,
  ts: `${threadTs.split(".")[0]}.${String(++evSeq).padStart(4, "0")}`,
  thread_ts: threadTs,
});
const humanReply = (threadTs: string, text: string) => ({
  type: "message",
  channel: CHANNEL,
  channel_type: "channel",
  user: HUMAN,
  text,
  ts: `${threadTs.split(".")[0]}.${String(++evSeq).padStart(4, "0")}`,
  thread_ts: threadTs,
});

const send = (presenceId: string, event: unknown) =>
  dispatch.dispatchSlackEvent({
    presenceId,
    identityRef: BOT,
    event,
    eventId: `Ev-${P}${++evSeq}`,
  });

const conversationOf = (agentId: string) =>
  db.conversation.findFirstOrThrow({
    where: { agentId, source: "slack" },
    select: { id: true, appTurnStreak: true },
  });

const reset = async () => {
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.policyRuleTarget.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.secret.deleteMany({ where: { name: { startsWith: P } } });
  slackCalls = [];
  slackHandlers = {};
  scriptDirectory();
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  const slackUrl = await startSlackFake();
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = slackUrl;
  process.env.ANTHROPIC_API_BASE_URL = slackUrl;
  process.env.OPENAI_API_BASE_URL = slackUrl;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  ({ db } = await import("@onecli/db"));
  dispatch = await import("./providers/slack/dispatch");
  reach = await import("./agent-reach-service");
  cap = await import("./app-turn-cap-service");
  approvals = await import("./action-approval-service");
  mentions = await import("./mention-resolution-service");
  ({ getCrypto } = await import("../../providers"));

  await reset();
  await db.workspaceAccess.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "AppCv", organizationId: ORG },
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

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await new Promise<void>((resolve) =>
    slackServer.close(() => resolve()),
  ).catch(() => {});
});

// ── The door ────────────────────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("app conversations (5a) — the door", () => {
  it("admits an app's mention in an APPROVED channel as a framed guest turn and counts it", async () => {
    const stage = await seedStage("admit");
    const result = await send(
      stage.presenceId,
      appMention("100.0000", "what time is it?"),
    );
    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.call.door === "group" && result.call.speakerKind).toBe("app");
    expect(result.outcome.kind).toBe("turn");

    const turn = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId: stage.agentId } },
    });
    expect(turn.userId).toBeNull();
    expect(turn.message).toBe(`guy-dev (app): @[Donna admit] what time is it?`);
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(1);
  });

  it("ignores an app SILENTLY in a members_only channel — no refusal text, no turn", async () => {
    const stage = await seedStage("members", "members_only");
    const result = await send(stage.presenceId, appMention("101.0000", "hi"));
    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome).toEqual({
      kind: "ignored",
      reason: "app-members-only",
    });
    expect(
      await db.turn.count({
        where: { conversation: { agentId: stage.agentId } },
      }),
    ).toBe(0);
    // The identity lane never ran for the app: no email lookup.
    expect(slackCallsFor("users.info")).toHaveLength(0);
  });

  it("drops a speaker whose directory flag CONTRADICTS the wire (fail closed, both ways)", async () => {
    const stage = await seedStage("mismatch");
    // Wire says app, directory says human.
    slackHandlers["users.info"] = (call) => ({
      user: {
        id: call.form.get("user"),
        team_id: TENANT,
        name: "impostor",
        profile: { display_name: "Impostor" },
      },
    });
    const asApp = await send(stage.presenceId, appMention("102.0000", "hi"));
    expect(asApp.kind).toBe("message");
    if (asApp.kind !== "message") throw new Error("unreachable");
    expect(asApp.outcome).toEqual({
      kind: "ignored",
      reason: "guest-kind-mismatch",
    });

    // Wire says person (a stranger), directory says bot.
    slackHandlers["users.info"] = (call) => ({
      user: {
        id: call.form.get("user"),
        team_id: TENANT,
        name: "sneaky-bot",
        is_bot: true,
        profile: { display_name: "Sneaky" },
      },
    });
    const asPerson = await send(stage.presenceId, {
      type: "app_mention",
      channel: CHANNEL,
      user: "U-STRANGER",
      text: `<@${BOT}> hi`,
      ts: "103.0001",
    });
    expect(asPerson.kind).toBe("message");
    if (asPerson.kind !== "message") throw new Error("unreachable");
    expect(asPerson.outcome).toEqual({
      kind: "ignored",
      reason: "guest-kind-mismatch",
    });
    expect(
      await db.turn.count({
        where: { conversation: { agentId: stage.agentId } },
      }),
    ).toBe(0);
  });

  it("a BLOCKED person-level row for the app's ref beats the open channel (the precedence law)", async () => {
    const stage = await seedStage("blocked");
    await reach.ensurePersonGrant({
      agentId: stage.agentId,
      integrationId: stage.integrationId,
      provider: "slack",
      externalRef: APP_USER,
    });
    await db.agentReachGrant.updateMany({
      where: { agentId: stage.agentId, subjectKind: "external_user" },
      data: { state: "blocked" },
    });
    const result = await send(stage.presenceId, appMention("104.0000", "hi"));
    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("unreachable");
    expect(result.outcome).toEqual({
      kind: "ignored",
      reason: "person-reach-denied",
    });
  });
});

// ── Heard when tagged; taggable once heard ─────────────────────────────────

describe.skipIf(!PROOF_URL)("app conversations (5a) — addressing", () => {
  it("an app's UN-TAGGED thread reply is ignored before the door; a person's still admits", async () => {
    const stage = await seedStage("untagged");
    const thread = "300.0000";
    // Join the thread first (a tagged app message creates the link).
    await send(stage.presenceId, appMention(thread, "hello"));
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(1);

    // The app posts in the thread WITHOUT tagging the agent: not for us.
    // Another agent's PAUSE LINE is exactly this shape (mention-free by
    // design), so two paused agents can never wake each other with it.
    for (const [ts, text] of [
      ["300.0002", "agreed, done here"],
      ["300.0003", cap.APP_TURN_PAUSE_MESSAGE],
    ] as const) {
      const untagged = await send(stage.presenceId, {
        type: "message",
        channel: CHANNEL,
        channel_type: "channel",
        user: APP_USER,
        bot_id: APP_BOT_ID,
        text,
        ts,
        thread_ts: thread,
      });
      expect(untagged).toEqual({
        kind: "ignored",
        reason: "app-unaddressed",
      });
    }
    // Nothing was spent: no streak, no turn, not even a dedupe row.
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(1);
    expect(
      await db.turn.count({
        where: { conversation: { agentId: stage.agentId }, userId: null },
      }),
    ).toBe(1);

    // A PERSON's un-tagged follow-up in the joined thread is still heard —
    // membership is their addressing signal.
    const person = await send(stage.presenceId, humanReply(thread, "carry on"));
    if (person.kind !== "message") throw new Error("unreachable");
    expect(["turn", "followUp"]).toContain(person.outcome.kind);
  });

  it("the room's apps are taggable from the FIRST turn: a human's kickoff seeds the app anchor, never the agent's own bot user", async () => {
    const stage = await seedStage("seed");
    // A HUMAN opens the thread - the app has not spoken yet.
    const kickoff = await send(stage.presenceId, {
      type: "app_mention",
      channel: CHANNEL,
      user: HUMAN,
      text: `<@${BOT}> <@${APP_USER}> you two, agree on the date`,
      ts: "301.0001",
    });
    if (kickoff.kind !== "message") throw new Error("unreachable");
    expect(["turn", "followUp"]).toContain(kickoff.outcome.kind);
    const conversation = await conversationOf(stage.agentId);

    const anchors = await db.mentionAnchor.findMany({
      where: { conversationId: conversation.id },
    });
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      kind: "app",
      externalUserId: APP_USER,
      displayName: "guy-dev",
    });
    // Exactly one roster walk per thread.
    expect(slackCallsFor("conversations.members")).toHaveLength(1);

    const resolved = await mentions.resolveMentionNames(
      stage.presenceId,
      ["guy-dev"],
      conversation.id,
    );
    expect(resolved).toEqual([
      {
        kind: "resolved",
        name: "guy-dev",
        externalUserId: APP_USER,
        displayName: "guy-dev",
      },
    ]);
    const note = await mentions.buildMentionContext(
      conversation.id,
      new Date(),
    );
    expect(note).toContain("Mentionable: guy-dev");

    // A second message in the thread does NOT re-walk the roster (the
    // kickoff's own ts is the thread root).
    await send(stage.presenceId, humanReply("301.0001", "more"));
    expect(slackCallsFor("conversations.members")).toHaveLength(1);
  });

  it("an app whose display name is a LINKED PERSON's name never captures it (@[name] still pings the human)", async () => {
    const stage = await seedStage("shadow");
    // The owner is linked as U-OWNER and named "Olive Owner"; the app now
    // calls itself exactly that - in the directory the seed reads AND in
    // the per-speaker probe.
    slackHandlers["users.list"] = () => ({
      members: [
        {
          id: APP_USER,
          team_id: TENANT,
          name: "olive",
          is_bot: true,
          profile: { display_name: "Olive Owner" },
        },
      ],
    });
    slackHandlers["users.info"] = (call) => ({
      user: {
        id: call.form.get("user"),
        team_id: TENANT,
        name: "olive",
        is_bot: true,
        profile: { display_name: "Olive Owner" },
      },
    });
    await send(stage.presenceId, appMention("302.0000", "hi"));
    const conversation = await conversationOf(stage.agentId);
    expect(
      await db.mentionAnchor.count({
        where: { conversationId: conversation.id },
      }),
    ).toBe(0);
    const resolved = await mentions.resolveMentionNames(
      stage.presenceId,
      ["Olive Owner"],
      conversation.id,
    );
    expect(resolved[0]).toMatchObject({
      kind: "resolved",
      externalUserId: "U-OWNER",
    });
  });
});

// ── The chain ───────────────────────────────────────────────────────────────

describe.skipIf(!PROOF_URL)("app conversations (5a) — the app-turn cap", () => {
  it("admits APP_TURN_CAP turns, pauses ONCE at the crossing with one continue card, then is silent", async () => {
    const stage = await seedStage("chain");
    const thread = "200.0000";

    for (let i = 1; i <= cap.APP_TURN_CAP; i += 1) {
      const result = await send(
        stage.presenceId,
        appMention(thread, `ping ${i}`),
      );
      if (result.kind !== "message") throw new Error("unreachable");
      expect(["turn", "followUp"]).toContain(result.outcome.kind);
    }
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(
      cap.APP_TURN_CAP,
    );
    const postsBefore = slackCallsFor("chat.postMessage").length;

    // The crossing: refused with the one pause line, exactly one hold.
    const seventh = await send(stage.presenceId, appMention(thread, "ping 7"));
    if (seventh.kind !== "message") throw new Error("unreachable");
    expect(seventh.outcome).toEqual({
      kind: "refused",
      message: cap.APP_TURN_PAUSE_MESSAGE,
    });
    const holds = await db.actionApproval.findMany({
      where: { agentId: stage.agentId, action: cap.APP_TURN_CONTINUE_ACTION },
    });
    expect(holds).toHaveLength(1);
    expect(holds[0]!.status).toBe("pending");
    // Plain words, no counts: the owner is asked to let the conversation
    // go on, and the thread is named so they know which one.
    // (The thread's title is its first message - here the app's own.)
    expect(holds[0]!.summary).toBe(
      'continue the conversation with other apps in "guy-dev (app): @[Donna chain] ping 1"',
    );
    // The frozen payload carries the parked, framed message.
    expect(holds[0]!.payload).toMatchObject({
      message: `guy-dev (app): @[Donna chain] ping 7`,
      source: "slack",
    });
    // The owner's card went out.
    expect(slackCallsFor("chat.postMessage").length).toBe(postsBefore + 1);
    // The lift has no always-allow upgrade (it IS the standing decision), so
    // the Slack card and the bell row both offer approve/reject only.
    const blocks = slackCallsFor("chat.postMessage").at(-1)?.form.get("blocks");
    expect(blocks).toContain("action_approve");
    expect(blocks).not.toContain("action_approve_always");
    const bell = await (
      await import("./workspace-approvals-service")
    ).listWorkspacePendingChannelApprovals(WORKSPACE);
    expect(bell).toContainEqual(
      expect.objectContaining({
        kind: "action",
        id: holds[0]!.id,
        offersAlwaysAllow: false,
      }),
    );

    // Past the crossing: silence, no second hold, no second card.
    const eighth = await send(stage.presenceId, appMention(thread, "ping 8"));
    if (eighth.kind !== "message") throw new Error("unreachable");
    expect(eighth.outcome).toEqual({ kind: "ignored", reason: "app-turn-cap" });
    expect(
      await db.actionApproval.count({
        where: { agentId: stage.agentId, action: cap.APP_TURN_CONTINUE_ACTION },
      }),
    ).toBe(1);
    expect(slackCallsFor("chat.postMessage").length).toBe(postsBefore + 1);
    // Six turns exist; the 7th and 8th never became one.
    expect(
      await db.turn.count({
        where: { conversation: { agentId: stage.agentId } },
      }),
    ).toBe(cap.APP_TURN_CAP);
  });

  it("a HUMAN turn in the thread resets the streak; the next app turn admits again", async () => {
    const stage = await seedStage("reset");
    const thread = "201.0000";
    for (let i = 1; i <= cap.APP_TURN_CAP; i += 1) {
      await send(stage.presenceId, appMention(thread, `ping ${i}`));
    }
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(
      cap.APP_TURN_CAP,
    );

    // A stranger human speaks in the joined thread (guest lane, person).
    const human = await send(stage.presenceId, humanReply(thread, "carry on"));
    if (human.kind !== "message") throw new Error("unreachable");
    expect(["turn", "followUp"]).toContain(human.outcome.kind);
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(0);

    const next = await send(stage.presenceId, appMention(thread, "ping again"));
    if (next.kind !== "message") throw new Error("unreachable");
    expect(["turn", "followUp"]).toContain(next.outcome.kind);
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(1);
  });

  it("approving CONTINUE is one more round: streak resets, the parked message replays, the next crossing asks AGAIN", async () => {
    const stage = await seedStage("continue");
    const thread = "202.0000";
    for (let i = 1; i <= cap.APP_TURN_CAP + 1; i += 1) {
      await send(stage.presenceId, appMention(thread, `ping ${i}`));
    }
    const hold = await db.actionApproval.findFirstOrThrow({
      where: { agentId: stage.agentId, action: cap.APP_TURN_CONTINUE_ACTION },
    });
    const turnsBefore = await db.turn.count({
      where: { conversation: { agentId: stage.agentId } },
    });

    const decided = await approvals.decideActionApproval({
      approvalId: hold.id,
      decision: "approve",
      deciderUserId: OWNER,
    });
    expect(decided).toEqual({ kind: "decided", status: "executed" });

    // The replay: the parked 7th message is now a turn, nobody typed - and
    // it is the round's FIRST turn, so the streak reads 1 after it lands.
    expect(
      await db.turn.count({
        where: { conversation: { agentId: stage.agentId } },
      }),
    ).toBe(turnsBefore + 1);
    const replayed = await db.turn.findFirstOrThrow({
      where: { conversation: { agentId: stage.agentId } },
      orderBy: { createdAt: "desc" },
    });
    expect(replayed.message).toBe(`guy-dev (app): @[Donna continue] ping 7`);
    expect(replayed.userId).toBeNull();
    // The replay goes through the SAME send door as an inbound turn, but the
    // door's landing hook is not on that path: the streak is the handler's
    // reset (0), and the next inbound app turn counts from there.
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(0);

    // One more round, never forever. The fake harness never finishes the
    // first turn, so every later message parks as a follow-up under the
    // unrelated follow-up cap (10); park the streak at the cap directly
    // rather than spend that queue, then the next message crosses AGAIN
    // and posts a FRESH card.
    const conversation = await conversationOf(stage.agentId);
    await db.conversation.update({
      where: { id: conversation.id },
      data: { appTurnStreak: cap.APP_TURN_CAP },
    });
    const again = await send(
      stage.presenceId,
      appMention(thread, "ping again"),
    );
    if (again.kind !== "message") throw new Error("unreachable");
    expect(again.outcome).toEqual({
      kind: "refused",
      message: cap.APP_TURN_PAUSE_MESSAGE,
    });
    expect(
      await db.actionApproval.count({
        where: {
          agentId: stage.agentId,
          action: cap.APP_TURN_CONTINUE_ACTION,
          status: "pending",
        },
      }),
    ).toBe(1);
  });

  it("COUNT ON LANDING: a refused landing costs no streak point; the crossing is exactly once under a race", async () => {
    const stage = await seedStage("landing");
    const thread = "205.0000";
    // Five app turns land (fake harness never finishes the first, so #2..#5
    // are parked follow-ups) - streak 5.
    for (let i = 1; i <= 5; i += 1) {
      await send(stage.presenceId, appMention(thread, `ping ${i}`));
    }
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(5);

    // Fill the follow-up queue to its cap with HUMAN follow-ups so the next
    // app message is refused by the unrelated follow-up cap - and must NOT
    // be counted.
    let humanRefused = false;
    for (let i = 0; i < 12 && !humanRefused; i += 1) {
      const r = await send(stage.presenceId, humanReply(thread, `h ${i}`));
      if (r.kind === "message" && r.outcome.kind === "refused")
        humanRefused = true;
    }
    expect(humanRefused).toBe(true);
    // Human turns landed meanwhile, so the streak is 0 again; a refused APP
    // landing now must leave it at 0.
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(0);
    const refusedApp = await send(
      stage.presenceId,
      appMention(thread, "ping x"),
    );
    if (refusedApp.kind !== "message") throw new Error("unreachable");
    expect(refusedApp.outcome.kind).toBe("refused");
    if (refusedApp.outcome.kind !== "refused") throw new Error("unreachable");
    expect(refusedApp.outcome.message).not.toBe(cap.APP_TURN_PAUSE_MESSAGE);
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(0);
    expect(
      await db.actionApproval.count({
        where: { agentId: stage.agentId, action: cap.APP_TURN_CONTINUE_ACTION },
      }),
    ).toBe(0);

    // THE RACE: park the streak at the cap directly (the claim is the seam
    // under test, not the landing path), then fire two app messages at once.
    const conversation = await conversationOf(stage.agentId);
    await db.conversation.update({
      where: { id: conversation.id },
      data: { appTurnStreak: cap.APP_TURN_CAP },
    });
    const [a, b] = await Promise.all([
      send(stage.presenceId, appMention(thread, "race a")),
      send(stage.presenceId, appMention(thread, "race b")),
    ]);
    const kinds = [a, b].map((r) =>
      r.kind === "message" ? r.outcome.kind : r.kind,
    );
    expect(kinds.sort()).toEqual(["ignored", "refused"]);
    expect(
      await db.actionApproval.count({
        where: { agentId: stage.agentId, action: cap.APP_TURN_CONTINUE_ACTION },
      }),
    ).toBe(1);
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(
      cap.APP_TURN_CAP + 1,
    );
  });

  it("VERIFY AT REPLAY: a card approved after the channel closed FAILS - nothing resumes, no turn", async () => {
    const stage = await seedStage("stale-room");
    const thread = "206.0000";
    for (let i = 1; i <= cap.APP_TURN_CAP + 1; i += 1) {
      await send(stage.presenceId, appMention(thread, `ping ${i}`));
    }
    const hold = await db.actionApproval.findFirstOrThrow({
      where: { agentId: stage.agentId, action: cap.APP_TURN_CONTINUE_ACTION },
    });
    const turnsBefore = await db.turn.count({
      where: { conversation: { agentId: stage.agentId } },
    });
    // The room closes to strangers AFTER the card was posted.
    await db.agentReachGrant.updateMany({
      where: { agentId: stage.agentId, subjectKind: "space" },
      data: { state: "members_only" },
    });

    const decided = await approvals.decideActionApproval({
      approvalId: hold.id,
      decision: "approve",
      deciderUserId: OWNER,
    });
    expect(decided).toEqual({ kind: "decided", status: "failed" });
    const row = await db.actionApproval.findUniqueOrThrow({
      where: { id: hold.id },
    });
    expect(row.reason).toContain("no longer open to everyone");
    // Still paused: the streak sits past the cap, nothing was reset.
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(
      cap.APP_TURN_CAP + 1,
    );
    expect(
      await db.turn.count({
        where: { conversation: { agentId: stage.agentId } },
      }),
    ).toBe(turnsBefore);
  });

  it("VERIFY AT REPLAY: a card approved after the app was BLOCKED fails the same way", async () => {
    const stage = await seedStage("stale-app");
    const thread = "207.0000";
    for (let i = 1; i <= cap.APP_TURN_CAP + 1; i += 1) {
      await send(stage.presenceId, appMention(thread, `ping ${i}`));
    }
    const hold = await db.actionApproval.findFirstOrThrow({
      where: { agentId: stage.agentId, action: cap.APP_TURN_CONTINUE_ACTION },
    });
    expect(hold.payload).toMatchObject({ appExternalRef: APP_USER });
    await reach.ensurePersonGrant({
      agentId: stage.agentId,
      integrationId: stage.integrationId,
      provider: "slack",
      externalRef: APP_USER,
    });
    await db.agentReachGrant.updateMany({
      where: { agentId: stage.agentId, subjectKind: "external_user" },
      data: { state: "blocked" },
    });

    const decided = await approvals.decideActionApproval({
      approvalId: hold.id,
      decision: "approve",
      deciderUserId: OWNER,
    });
    expect(decided).toEqual({ kind: "decided", status: "failed" });
    const row = await db.actionApproval.findUniqueOrThrow({
      where: { id: hold.id },
    });
    expect(row.reason).toContain("blocked this app");
    expect((await conversationOf(stage.agentId)).appTurnStreak).toBe(
      cap.APP_TURN_CAP + 1,
    );
  });
});
