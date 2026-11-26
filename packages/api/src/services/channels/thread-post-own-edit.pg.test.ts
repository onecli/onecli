import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { proofDatabaseUrl } from "../../testing/pg-proof";

/**
 * The agent posts into an existing thread, and edits or deletes ITS OWN
 * messages elsewhere, driven through the real tool door. Contacts' "Can
 * talk with" must allow the agent there (Never = no post, edit, or delete,
 * and no card for an edit or delete), and who may ask depends on the
 * message: a schedule reaches the posts it sent; a channel's posts, anyone
 * asking in that channel or a workspace owner; a DM's posts, only the
 * person it is with. Most cases run from a SCHEDULED turn (a cron
 * conversation with no Slack thread link, no person behind it), the weekly
 * routine this exists for.
 */

const PROOF_URL = proofDatabaseUrl();
const P = "tpoe-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OWNER = `${P}owner`;
const MEMBER = `${P}member`;
const DANA = `${P}dana`;
const TEAM = "T0TPOE";
const BOT_USER = "U0TPOEBOT";
const APP = "A0TPOE";
const ON = "C0ONROOM";
const OFF = "C0OFFROOM";
const OTHER = "C0OTHER";
const OWNER_SLACK = "U0OLIVE";
const MEMBER_SLACK = "U0MIA";
const DANA_SLACK = "U0DANA";
const DANA_IM = "D0DANAIM";

let db: typeof import("@onecli/db").db;
let tools: typeof import("../platform-tool-service");
let providers: typeof import("../../providers");

// ── Fake Slack: remembers what was posted, answers reads from it ──────────
interface FakeMessage {
  channel: string;
  ts: string;
  thread_ts?: string;
  app_id?: string;
  user?: string;
  subtype?: string;
  text: string;
  blocks?: unknown[];
}
let messages: FakeMessage[] = [];
const calls: { method: string; form: URLSearchParams }[] = [];
let tsSeq = 0;
const nextTs = () =>
  `${Math.floor(Date.now() / 1000)}.${String(++tsSeq).padStart(6, "0")}`;

const inBounds = (m: FakeMessage, form: URLSearchParams): boolean => {
  const ts = Number(m.ts);
  const oldest = form.get("oldest");
  const latest = form.get("latest");
  const inclusive = form.get("inclusive") === "true";
  if (oldest && (inclusive ? ts < Number(oldest) : ts <= Number(oldest)))
    return false;
  if (latest && (inclusive ? ts > Number(latest) : ts >= Number(latest)))
    return false;
  return true;
};

/** Slack's `conversations.replies`: `ts` may name the parent or any reply
 * (the whole thread comes back, parent first, whatever the bounds); an
 * unthreaded message comes back alone; an unknown ts is thread_not_found. */
const replies = (channel: string, form: URLSearchParams): unknown => {
  const asked = messages.find(
    (m) => m.channel === channel && m.ts === form.get("ts"),
  );
  if (!asked) return { ok: false, error: "thread_not_found" };
  const root = asked.thread_ts ?? asked.ts;
  const parent = messages.find((m) => m.channel === channel && m.ts === root);
  const rest = messages
    .filter(
      (m) =>
        m.channel === channel &&
        m.thread_ts === root &&
        m.ts !== root &&
        inBounds(m, form),
    )
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  return {
    ok: true,
    messages: [...(parent ? [parent] : []), ...rest],
    has_more: false,
    response_metadata: { next_cursor: "" },
  };
};

const answer = (method: string, form: URLSearchParams): unknown => {
  const channel = form.get("channel") ?? "";
  switch (method) {
    case "conversations.list":
      return {
        ok: true,
        channels: [
          { id: ON, name: "team-updates", is_member: true },
          { id: OFF, name: "off-room", is_member: true },
          { id: OTHER, name: "other-room", is_member: true },
        ],
      };
    case "conversations.open":
      return { ok: true, channel: { id: DANA_IM } };
    case "chat.postMessage": {
      const ts = nextTs();
      const threadTs = form.get("thread_ts") ?? undefined;
      messages.push({
        channel,
        ts,
        ...(threadTs && { thread_ts: threadTs }),
        app_id: APP,
        user: BOT_USER,
        text: form.get("text") ?? "",
      });
      return { ok: true, channel, ts };
    }
    case "conversations.history":
      return {
        ok: true,
        messages: messages
          .filter(
            (m) =>
              m.channel === channel &&
              (!m.thread_ts || m.thread_ts === m.ts) &&
              inBounds(m, form),
          )
          .sort((a, b) => Number(b.ts) - Number(a.ts)),
        has_more: false,
      };
    case "conversations.replies":
      return replies(channel, form);
    default:
      return { ok: true };
  }
};

let slackServer: Server;
const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        const method = (req.url ?? "/").slice(1);
        const form = new URLSearchParams(raw);
        calls.push({ method, form });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer(method, form)));
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

const callsOf = (method: string) => calls.filter((c) => c.method === method);
const writes = () =>
  calls.filter((c) => c.method === "chat.update" || c.method === "chat.delete");

// ── Seeds ─────────────────────────────────────────────────────────────────
let integrationId: string;

interface Caller {
  conversationId: string;
  turnId: string;
}

interface Stage extends Caller {
  agentId: string;
  presenceId: string;
  runnerId: string;
  sandboxId: string;
}

/** An agent with a live Slack presence, running a SCHEDULED turn: a cron
 * conversation with no channel thread link and no person behind it. */
const seedStage = async (suffix: string): Promise<Stage> => {
  const agent = await db.agent.create({
    data: {
      identifier: `${P}agent-${suffix}`,
      name: "Wes",
      workspaceId: WORKSPACE,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  const credentials = await providers
    .getCrypto()
    .encrypt(JSON.stringify({ botToken: `xoxb-${suffix}` }));
  const presence = await db.agentChannel.create({
    data: {
      agentId: agent.id,
      integrationId,
      provider: "slack",
      externalId: APP,
      identityRef: BOT_USER,
      transport: "socket",
      status: "active",
      credentials,
    },
    select: { id: true },
  });
  const run = await scheduleRun(agent.id, suffix);
  const runnerId = `${P}runner-${suffix}`;
  const sandboxId = `${P}sb-${suffix}`;
  await db.runner.create({
    data: { id: runnerId, name: "runner", token: `rnr_${P}${suffix}` },
  });
  await db.sandbox.create({
    data: { id: sandboxId, agentId: agent.id, runnerId, status: "running" },
  });
  for (const [kind, ref, state] of [
    ["space", ON, "approved"],
    ["space", OFF, "blocked"],
    ["space", OTHER, "approved"],
    ["external_user", DANA_SLACK, "approved"],
  ] as const) {
    await db.agentReachGrant.create({
      data: {
        agentId: agent.id,
        integrationId,
        provider: "slack",
        subjectKind: kind,
        externalRef: ref,
        subjectLabel: ref,
        state,
        decidedByUserId: OWNER,
      },
    });
  }
  return {
    agentId: agent.id,
    presenceId: presence.id,
    ...run,
    runnerId,
    sandboxId,
  };
};

/** A schedule's own fire: its cron conversation and a platform turn. */
const scheduleRun = async (agentId: string, ref: string): Promise<Caller> => {
  const conversation = await db.conversation.create({
    data: { agentId, source: "cron", externalRef: `${P}${ref}` },
    select: { id: true },
  });
  const turn = await db.turn.create({
    data: {
      conversationId: conversation.id,
      message: "weekly update",
      status: "running",
      source: "cron",
    },
    select: { id: true },
  });
  return { conversationId: conversation.id, turnId: turn.id };
};

/** A person's own direct chat with the agent (web chat and DM are one). */
const directChat = async (stage: Stage, userId: string): Promise<Caller> => {
  const conversation = await db.conversation.create({
    data: { agentId: stage.agentId, source: "web", direct: true, userId },
    select: { id: true },
  });
  const turn = await db.turn.create({
    data: {
      conversationId: conversation.id,
      message: "fix that",
      status: "running",
      source: "web",
      userId,
    },
    select: { id: true },
  });
  return { conversationId: conversation.id, turnId: turn.id };
};

/** Someone talking to the agent in a thread of a Slack channel. */
const channelThread = async (
  stage: Stage,
  channel: string,
  userId: string,
): Promise<Caller> => {
  const root = nextTs();
  const conversation = await db.conversation.create({
    data: { agentId: stage.agentId, source: "slack", externalRef: root },
    select: { id: true },
  });
  await db.channelThreadLink.create({
    data: {
      agentChannelId: stage.presenceId,
      conversationId: conversation.id,
      externalThreadId: `${channel}:${root}`,
      kind: "group",
    },
  });
  const turn = await db.turn.create({
    data: {
      conversationId: conversation.id,
      message: "fix that",
      status: "running",
      source: "slack",
      userId,
    },
    select: { id: true },
  });
  return { conversationId: conversation.id, turnId: turn.id };
};

const tool = (
  stage: Stage,
  name: string,
  args: unknown,
  from: Caller = stage,
) =>
  tools.executePlatformTool(stage.runnerId, {
    sandboxId: stage.sandboxId,
    tool: name,
    args,
    conversationId: from.conversationId,
    turnId: from.turnId,
  });

const permalink = (channel: string, ts: string) =>
  `https://acme-example.slack.com/archives/${channel}/p${ts.replace(".", "")}`;

const postedBy = (stage: Stage, from: Caller, to: string, text: string) =>
  tool(stage, "send_message", { to, text, sendAs: "agent" }, from).then(
    () => messages.at(-1)!.ts,
  );

const reset = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = await startSlackFake();
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  ({ db } = await import("@onecli/db"));
  providers = await import("../../providers");
  tools = await import("../platform-tool-service");

  await reset();
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "TPOE", organizationId: ORG },
  });
  integrationId = (
    await db.channelIntegration.create({
      data: {
        organizationId: ORG,
        provider: "slack",
        externalId: TEAM,
        name: "TPOE Slack",
      },
      select: { id: true },
    })
  ).id;
  for (const [id, name, role, slack] of [
    [OWNER, "Olive Owner", "owner", OWNER_SLACK],
    [MEMBER, "Mia Member", "member", MEMBER_SLACK],
    [DANA, "Dana Kim", "member", DANA_SLACK],
  ] as const) {
    await db.user.create({
      data: { id, email: `${id}@example.com`, externalAuthId: id, name },
    });
    await db.workspaceAccess.create({
      data: { workspaceId: WORKSPACE, userId: id, role },
    });
    await db.channelUserLink.create({
      data: {
        integrationId,
        externalUserId: slack,
        userId: id,
        linkedVia: "manual",
      },
    });
  }
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
  messages = [];
  calls.length = 0;
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  slackServer?.close();
});

describe.skipIf(!PROOF_URL)("posting into a thread", () => {
  it("from a schedule: a top-level post to an allowed channel goes out with no card, and its ts is recorded", async () => {
    const stage = await seedStage("top");
    const result = await tool(stage, "send_message", {
      to: "#team-updates",
      text: "Weekly update",
    });
    expect(result).toMatchObject({ ok: true, result: { status: "sent" } });
    const [post] = callsOf("chat.postMessage");
    expect(post?.form.get("channel")).toBe(ON);
    expect(post?.form.get("thread_ts")).toBeNull();
    const row = await db.channelSentMessage.findFirstOrThrow({
      where: { agentChannelId: stage.presenceId },
    });
    expect(row.messageRef).toBe(messages[0]!.ts);
    expect(row.externalThreadId).toBe(`${ON}:${messages[0]!.ts}`);
    expect(
      await db.actionApproval.count({ where: { agentId: stage.agentId } }),
    ).toBe(0);
  });

  it("from a schedule: a post into a thread by permalink posts with thread_ts and records both ids", async () => {
    const stage = await seedStage("thread");
    const root = "1781870000.123579";
    messages.push({ channel: ON, ts: root, user: "U0HUMAN", text: "kickoff" });
    const result = await tool(stage, "send_message", {
      to: "#team-updates",
      text: "Following up",
      thread: permalink(ON, root),
    });
    expect(result).toMatchObject({ ok: true, result: { status: "sent" } });
    const [post] = callsOf("chat.postMessage");
    expect(post?.form.get("thread_ts")).toBe(root);
    const row = await db.channelSentMessage.findFirstOrThrow({
      where: { agentChannelId: stage.presenceId },
    });
    expect(row.externalThreadId).toBe(`${ON}:${root}`);
    expect(row.messageRef).not.toBe(root);
    expect(row.messageRef).toBe(messages.at(-1)!.ts);
  });

  it("a bare message id inside a thread posts under that thread's root (Slack's thread_ts rule), and the ledger records the root", async () => {
    const stage = await seedStage("rawts");
    const root = "1781870000.000001";
    const reply = "1781870000.000002";
    messages.push(
      { channel: ON, ts: root, user: "U0HUMAN", text: "kickoff" },
      { channel: ON, ts: reply, thread_ts: root, user: "U0HUMAN", text: "+1" },
    );
    const result = await tool(stage, "send_message", {
      to: "#team-updates",
      text: "hi",
      thread: reply,
    });
    expect(result).toMatchObject({ ok: true, result: { status: "sent" } });
    expect(callsOf("chat.postMessage")[0]?.form.get("thread_ts")).toBe(root);
    const row = await db.channelSentMessage.findFirstOrThrow({
      where: { agentChannelId: stage.presenceId },
    });
    expect(row.externalThreadId).toBe(`${ON}:${root}`);
  });

  it("a bare message id that isn't in the recipient's channel is refused before anything posts", async () => {
    const stage = await seedStage("raw-foreign");
    messages.push({
      channel: OTHER,
      ts: "1781870000.000009",
      user: "U0HUMAN",
      text: "elsewhere",
    });
    const result = await tool(stage, "send_message", {
      to: "#team-updates",
      text: "hi",
      thread: "1781870000.000009",
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("That thread isn't in #team-updates."),
    });
    expect(callsOf("chat.postMessage")).toHaveLength(0);
  });

  it("a thread link from another channel is refused before Slack is asked anything", async () => {
    const stage = await seedStage("mismatch");
    const result = await tool(stage, "send_message", {
      to: "#team-updates",
      text: "hi",
      thread: permalink(OTHER, "1781870000.123579"),
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("That thread isn't in #team-updates."),
    });
    expect(callsOf("chat.postMessage")).toHaveLength(0);
    expect(callsOf("conversations.replies")).toHaveLength(0);
  });

  it("something that is neither a message link nor a message id is refused at the door", async () => {
    const stage = await seedStage("bad-thread");
    const result = await tool(stage, "send_message", {
      to: "#team-updates",
      text: "hi",
      thread: "https://example.com/not-slack",
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Nothing was sent."),
    });
    expect(calls.filter((c) => c.method !== "conversations.list")).toEqual([]);
  });

  it("from a schedule: a Never channel refuses the post (top-level and thread) with the Contacts message", async () => {
    const stage = await seedStage("never");
    for (const args of [
      { to: "#off-room", text: "hi" },
      {
        to: "#off-room",
        text: "hi",
        thread: permalink(OFF, "1781870000.100000"),
      },
    ]) {
      const result = await tool(stage, "send_message", args);
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Change it in Contacts"),
      });
    }
    expect(callsOf("chat.postMessage")).toHaveLength(0);
  });
});

describe.skipIf(!PROOF_URL)("changing its own messages elsewhere", () => {
  it("a schedule edits and deletes its own post in another channel, with no card", async () => {
    const stage = await seedStage("edit");
    await tool(stage, "send_message", { to: "#team-updates", text: "v1" });
    const ts = messages[0]!.ts;

    const listed = await tool(stage, "list_my_replies", {
      conversation: "#team-updates",
    });
    expect(listed).toMatchObject({
      ok: true,
      result: { replies: [expect.objectContaining({ messageId: ts })] },
    });

    const edited = await tool(stage, "edit_my_reply", {
      conversation: "#team-updates",
      messageId: ts,
      text: "v2",
    });
    expect(edited).toMatchObject({ ok: true, result: { status: "edited" } });
    const update = callsOf("chat.update")[0]!;
    expect(update.form.get("channel")).toBe(ON);
    expect(update.form.get("ts")).toBe(ts);

    const deleted = await tool(stage, "delete_my_reply", {
      conversation: "#team-updates",
      messageId: ts,
    });
    expect(deleted).toMatchObject({ ok: true, result: { status: "deleted" } });
    expect(callsOf("chat.delete")[0]?.form.get("ts")).toBe(ts);
    expect(
      await db.actionApproval.count({ where: { agentId: stage.agentId } }),
    ).toBe(0);
  });

  it("a schedule edits its own reply inside a thread it posted into (found through the ledger)", async () => {
    const stage = await seedStage("edit-thread");
    const root = "1781870000.555555";
    messages.push({ channel: ON, ts: root, user: "U0HUMAN", text: "kickoff" });
    await tool(stage, "send_message", {
      to: "#team-updates",
      text: "in thread",
      thread: permalink(ON, root),
    });
    const ts = messages.at(-1)!.ts;
    const listed = await tool(stage, "list_my_replies", {
      conversation: "#team-updates",
    });
    expect(listed).toMatchObject({
      ok: true,
      result: { replies: [expect.objectContaining({ messageId: ts })] },
    });
    const edited = await tool(stage, "edit_my_reply", {
      conversation: "#team-updates",
      messageId: ts,
      text: "fixed",
    });
    expect(edited).toMatchObject({ ok: true, result: { status: "edited" } });
  });

  it("a schedule reaches only the posts IT sent: another schedule's post there is listed by neither and refused", async () => {
    const stage = await seedStage("own-schedule");
    const other = await scheduleRun(stage.agentId, "own-schedule-2");
    const mine = await postedBy(stage, stage, "#team-updates", "mine");
    const theirs = await postedBy(stage, other, "#team-updates", "theirs");

    const listed = await tool(stage, "list_my_replies", {
      conversation: "#team-updates",
    });
    expect(listed).toMatchObject({ ok: true });
    const ids = (
      listed as { result: { replies: { messageId: string }[] } }
    ).result.replies.map((r) => r.messageId);
    expect(ids).toEqual([mine]);

    const refused = await tool(stage, "delete_my_reply", {
      conversation: "#team-updates",
      messageId: theirs,
    });
    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringContaining("this schedule sent"),
    });
    expect(writes()).toHaveLength(0);
  });

  it("a person typing into a schedule's conversation is not the schedule: refused", async () => {
    const stage = await seedStage("typed-into-run");
    const ts = await postedBy(stage, stage, "#team-updates", "v1");
    await db.turn.update({
      where: { id: stage.turnId },
      data: { status: "done", finishedAt: new Date() },
    });
    const typed = await db.turn.create({
      data: {
        conversationId: stage.conversationId,
        message: "delete it",
        status: "running",
        source: "web",
        userId: MEMBER,
      },
      select: { id: true },
    });
    const result = await tool(
      stage,
      "delete_my_reply",
      { conversation: "#team-updates", messageId: ts },
      { conversationId: stage.conversationId, turnId: typed.id },
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Only someone asking in #team-updates"),
    });
    expect(writes()).toHaveLength(0);
  });

  it("anyone asking IN that channel may change the agent's posts there; the audit names the channel changed", async () => {
    const stage = await seedStage("in-channel");
    const ts = await postedBy(stage, stage, "#team-updates", "v1");
    const there = await channelThread(stage, ON, MEMBER);
    const result = await tool(
      stage,
      "edit_my_reply",
      { conversation: "#team-updates", messageId: ts, text: "v2" },
      there,
    );
    expect(result).toMatchObject({ ok: true, result: { status: "edited" } });
    const audit = await db.auditLog.findFirstOrThrow({
      where: { workspaceId: WORKSPACE, userId: MEMBER },
      select: { metadata: true },
    });
    expect(audit.metadata).toMatchObject({
      messageId: ts,
      conversationRef: ON,
      conversationId: there.conversationId,
    });
  });

  it("asking from ANOTHER channel, or a member's private chat, is refused (negative controls)", async () => {
    const stage = await seedStage("not-there");
    const ts = await postedBy(stage, stage, "#team-updates", "v1");
    // Owning a DIFFERENT workspace makes nobody an owner here.
    const elsewhere = await db.workspace.create({
      data: { name: "Elsewhere", organizationId: ORG },
      select: { id: true },
    });
    await db.workspaceAccess.create({
      data: { workspaceId: elsewhere.id, userId: MEMBER, role: "owner" },
    });
    try {
      for (const from of [
        await channelThread(stage, OTHER, MEMBER),
        await directChat(stage, MEMBER),
      ]) {
        for (const [name, args] of [
          [
            "edit_my_reply",
            { conversation: "#team-updates", messageId: ts, text: "x" },
          ],
          ["delete_my_reply", { conversation: "#team-updates", messageId: ts }],
          ["list_my_replies", { conversation: "#team-updates" }],
        ] as const) {
          const result = await tool(stage, name, args, from);
          expect(result).toMatchObject({
            ok: false,
            error: expect.stringContaining(
              "Only someone asking in #team-updates itself, or a workspace owner",
            ),
          });
        }
      }
      expect(writes()).toHaveLength(0);
    } finally {
      await db.workspace.delete({ where: { id: elsewhere.id } });
    }
  });

  it("a workspace owner may change the agent's channel posts from their own private chat", async () => {
    const stage = await seedStage("owner");
    const ts = await postedBy(stage, stage, "#team-updates", "v1");
    const result = await tool(
      stage,
      "delete_my_reply",
      { conversation: "#team-updates", messageId: ts },
      await directChat(stage, OWNER),
    );
    expect(result).toMatchObject({ ok: true, result: { status: "deleted" } });
    expect(callsOf("chat.delete")).toHaveLength(1);
  });

  it("a DM post (sent before any DM link existed) is found in the IM and changed only by the person it is with", async () => {
    const stage = await seedStage("dm");
    const ts = await postedBy(stage, stage, "Dana Kim", "hi Dana");
    expect(messages.at(-1)!.channel).toBe(DANA_IM);

    const refusedFrom = [
      await directChat(stage, MEMBER),
      await directChat(stage, OWNER),
      await channelThread(stage, ON, DANA),
    ];
    for (const from of refusedFrom) {
      const result = await tool(
        stage,
        "edit_my_reply",
        { conversation: "Dana Kim", messageId: ts, text: "x" },
        from,
      );
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          "Only Dana Kim, in their own chat with you",
        ),
      });
    }
    expect(writes()).toHaveLength(0);

    const dana = await directChat(stage, DANA);
    const listed = await tool(
      stage,
      "list_my_replies",
      { conversation: "Dana Kim" },
      dana,
    );
    expect(listed).toMatchObject({
      ok: true,
      result: { replies: [expect.objectContaining({ messageId: ts })] },
    });
    const edited = await tool(
      stage,
      "edit_my_reply",
      { conversation: "Dana Kim", messageId: ts, text: "hi again" },
      dana,
    );
    expect(edited).toMatchObject({ ok: true, result: { status: "edited" } });
    expect(callsOf("chat.update")[0]?.form.get("channel")).toBe(DANA_IM);
  });

  it("a thread post inside a DM is found through the ledger and edited by the schedule that sent it", async () => {
    const stage = await seedStage("dm-thread");
    const root = "1781870000.777777";
    messages.push({
      channel: DANA_IM,
      ts: root,
      user: DANA_SLACK,
      text: "question",
    });
    await tool(stage, "send_message", {
      to: "Dana Kim",
      text: "answer in thread",
      thread: root,
    });
    const ts = messages.at(-1)!.ts;
    expect(messages.at(-1)!.thread_ts).toBe(root);
    const listed = await tool(stage, "list_my_replies", {
      conversation: "Dana Kim",
    });
    expect(listed).toMatchObject({
      ok: true,
      result: { replies: [expect.objectContaining({ messageId: ts })] },
    });
    const edited = await tool(stage, "edit_my_reply", {
      conversation: "Dana Kim",
      messageId: ts,
      text: "fixed",
    });
    expect(edited).toMatchObject({ ok: true, result: { status: "edited" } });
  });

  it("refuses edit and delete in a Never channel, even of its own message", async () => {
    const stage = await seedStage("never-edit");
    const ts = nextTs();
    messages.push({
      channel: OFF,
      ts,
      app_id: APP,
      user: BOT_USER,
      text: "old",
    });
    for (const [name, args] of [
      [
        "edit_my_reply",
        { conversation: "#off-room", messageId: ts, text: "x" },
      ],
      ["delete_my_reply", { conversation: "#off-room", messageId: ts }],
      ["list_my_replies", { conversation: "#off-room" }],
    ] as const) {
      const result = await tool(stage, name, args);
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          "Wes isn't allowed to talk in #off-room. Change it in Contacts.",
        ),
      });
    }
    expect(writes()).toHaveLength(0);
  });

  it("refuses someone else's message, a card, and a message older than 24 hours, even for an owner", async () => {
    const stage = await seedStage("not-own");
    const human = nextTs();
    const card = nextTs();
    const old = `${Math.floor(Date.now() / 1000) - 25 * 3600}.000001`;
    messages.push(
      { channel: ON, ts: human, user: "U0HUMAN", text: "theirs" },
      {
        channel: ON,
        ts: card,
        app_id: APP,
        user: BOT_USER,
        text: "card",
        blocks: [{ type: "section" }],
      },
      { channel: ON, ts: old, app_id: APP, user: BOT_USER, text: "old" },
    );
    const owner = await directChat(stage, OWNER);
    for (const messageId of [human, card, old]) {
      const result = await tool(
        stage,
        "edit_my_reply",
        { conversation: "#team-updates", messageId, text: "x" },
        owner,
      );
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("isn't one of your own messages"),
      });
    }
    expect(writes()).toHaveLength(0);
  });

  it("without conversation, a scheduled turn still has no current conversation to change", async () => {
    const stage = await seedStage("no-conv");
    const result = await tool(stage, "list_my_replies", {});
    expect(result.ok).toBe(false);
  });
});
