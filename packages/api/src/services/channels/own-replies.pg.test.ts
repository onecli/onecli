import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { proofDatabaseUrl } from "../../testing/pg-proof";

/**
 * The agent edits and deletes ITS OWN replies in the conversation it is in
 * right now, driven through the real tool door. Pinned here:
 *  - authorship by app id: a reply posted with the agent's avatar comes back
 *    as `bot_message` with no `user`, and still counts as the agent's;
 *  - only PLAIN replies: cards (Block Kit), the web mirror's copy of a
 *    person's words, other apps and people never count;
 *  - a long thread is walked to its newest end (Slack pages it oldest first);
 *  - only the calling turn's own conversation, never another agent's;
 *  - an id that is not the agent's plain reply in this thread from the last
 *    24 hours is refused before Slack is asked to change anything;
 *  - an edit renders like any answer (markdown to mrkdwn, injected
 *    broadcasts escaped, resolved mentions ping) and is audited without text;
 *  - a dead token flips the presence (the bell alert); any other refusal
 *    reaches the model as words it can act on, not "try again".
 */

const PROOF_URL = proofDatabaseUrl();
const P = "ownreply-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OWNER = `${P}owner`;
const TEAM = "T0OWNREPLY";
const BOT_USER = "U0BOTSELF";
const CHANNEL = "C0THREAD";
const ROOT = "1793000000.000100";
const DM = "D0DIRECT";

let db: typeof import("@onecli/db").db;
let tools: typeof import("../platform-tool-service");
let providers: typeof import("../../providers");
let service: typeof import("./own-replies-service");

// ── Fake Slack ─────────────────────────────────────────────────────────────
interface FakeMessage {
  ts: string;
  user?: string;
  app_id?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  blocks?: unknown[];
}
/** Conversation messages, any order: the fake sorts like Slack does. */
let messages: FakeMessage[] = [];
/** Slack error code per method; absent = ok. */
const methodErrors = new Map<string, string>();
const calls: { method: string; form: URLSearchParams }[] = [];

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

const answer = (method: string, form: URLSearchParams): unknown => {
  const limit = Number(form.get("limit") ?? 100);
  if (method === "conversations.replies") {
    // Oldest first; the parent (the `ts` asked for) leads every page
    // whatever the bounds say.
    const root = form.get("ts");
    const parent = messages.find((m) => m.ts === root);
    const window = messages
      .filter((m) => m.ts !== root && inBounds(m, form))
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    const start = Number(form.get("cursor") ?? 0);
    const page = window.slice(start, start + limit);
    const next = start + limit < window.length ? String(start + limit) : "";
    return {
      ok: true,
      messages: [...(parent ? [parent] : []), ...page],
      has_more: next !== "",
      response_metadata: { next_cursor: next },
    };
  }
  if (method === "conversations.history") {
    const page = messages
      .filter((m) => inBounds(m, form))
      .sort((a, b) => Number(b.ts) - Number(a.ts))
      .slice(0, limit);
    return { ok: true, messages: page, has_more: false };
  }
  return { ok: true };
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
        const error = methodErrors.get(method) ?? methodErrors.get("*");
        res.end(
          JSON.stringify(error ? { ok: false, error } : answer(method, form)),
        );
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

const tsAgo = (now: number, ms: number) => ((now - ms) / 1000).toFixed(6);

let integrationId: string;

interface Stage {
  agentId: string;
  appId: string;
  presenceId: string;
  conversationId: string;
  turnId: string;
  runnerId: string;
  sandboxId: string;
}

const seedStage = async (
  suffix: string,
  opts: {
    kind?: "group" | "direct";
    status?: string;
    /** The calling turn arrived in this thread (`Turn.sourceThreadId`). */
    sourceThreadId?: string;
    /** The link's address; defaults to the group thread or the DM. */
    externalThreadId?: string;
  } = {},
): Promise<Stage> => {
  const kind = opts.kind ?? "group";
  const appId = `A0${suffix.toUpperCase()}`;
  const agent = await db.agent.create({
    data: {
      identifier: `${P}agent-${suffix}`,
      name: `Agent ${suffix}`,
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
      externalId: appId,
      identityRef: BOT_USER,
      transport: "socket",
      status: opts.status ?? "active",
      credentials,
    },
    select: { id: true },
  });
  const conversation = await db.conversation.create({
    data: {
      agentId: agent.id,
      source: "slack",
      externalRef: `${P}${suffix}`,
      ...(kind === "direct" && { direct: true, userId: OWNER }),
    },
    select: { id: true },
  });
  const turn = await db.turn.create({
    data: {
      conversationId: conversation.id,
      userId: OWNER,
      message: "fix your last answer",
      status: "running",
      ...(opts.sourceThreadId && { sourceThreadId: opts.sourceThreadId }),
    },
    select: { id: true },
  });
  await db.channelThreadLink.create({
    data: {
      agentChannelId: presence.id,
      conversationId: conversation.id,
      externalThreadId:
        opts.externalThreadId ??
        (kind === "direct" ? DM : `${CHANNEL}:${ROOT}`),
      kind,
    },
  });
  const runnerId = `${P}runner-${suffix}`;
  const sandboxId = `${P}sb-${suffix}`;
  await db.runner.create({
    data: { id: runnerId, name: "runner", token: `rnr_${P}${suffix}` },
  });
  await db.sandbox.create({
    data: { id: sandboxId, agentId: agent.id, runnerId, status: "running" },
  });
  return {
    agentId: agent.id,
    appId,
    presenceId: presence.id,
    conversationId: conversation.id,
    turnId: turn.id,
    runnerId,
    sandboxId,
  };
};

/** `conversationId: null` = a call with no conversation context at all. */
const tool = (
  stage: Stage,
  name: string,
  args: unknown,
  conversationId: string | null = stage.conversationId,
) =>
  tools.executePlatformTool(stage.runnerId, {
    sandboxId: stage.sandboxId,
    tool: name,
    args,
    ...(conversationId !== null && { conversationId, turnId: stage.turnId }),
  });

const writes = () =>
  calls.filter((c) => c.method === "chat.update" || c.method === "chat.delete");

const reset = async () => {
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
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
  service = await import("./own-replies-service");

  await reset();
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Own WS", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.com`,
      externalAuthId: OWNER,
      name: "Olive Owner",
    },
  });
  integrationId = (
    await db.channelIntegration.create({
      data: {
        organizationId: ORG,
        provider: "slack",
        externalId: TEAM,
        name: "Own Slack",
        createdByUserId: OWNER,
      },
      select: { id: true },
    })
  ).id;
  await db.channelUserLink.create({
    data: {
      integrationId,
      externalUserId: "U0OLIVE",
      userId: OWNER,
      linkedVia: "manual",
    },
  });
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
  messages = [];
  methodErrors.clear();
  calls.length = 0;
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  slackServer?.close();
});

describe.skipIf(!PROOF_URL)("the agent's own replies (tool door)", () => {
  it("lists avatar and plain replies by app id, newest first, and nothing else", async () => {
    const stage = await seedStage("list");
    const now = Date.now();
    const avatar = tsAgo(now, 30_000);
    const plain = tsAgo(now, 60_000);
    messages = [
      { ts: ROOT, user: "U0HUMAN", text: "question" },
      // The agent's answer posted with its avatar: no `user` at all.
      {
        ts: avatar,
        app_id: stage.appId,
        bot_id: "B0SELF",
        subtype: "bot_message",
        text: "second answer <@U0OLIVE>",
      },
      { ts: plain, app_id: stage.appId, user: BOT_USER, text: "first answer" },
      // An approval card: Block Kit, never a plain reply.
      {
        ts: tsAgo(now, 50_000),
        app_id: stage.appId,
        user: BOT_USER,
        text: "Approve?",
        blocks: [{ type: "section" }],
      },
      // The web mirror's copy of a person's words.
      {
        ts: tsAgo(now, 40_000),
        app_id: stage.appId,
        user: BOT_USER,
        text: "_(:globe_with_meridians: · Olive)_ also check Q3",
      },
      // Another app in the same thread.
      {
        ts: tsAgo(now, 45_000),
        app_id: "A0OTHER",
        user: "U0OTHERBOT",
        text: "other bot",
      },
      {
        ts: tsAgo(now, 25 * 60 * 60 * 1000),
        app_id: stage.appId,
        text: "too old",
      },
    ];

    const res = await tool(stage, "list_my_replies", {});
    expect(res).toMatchObject({ ok: true });
    const replies = (
      res as { result: { replies: { messageId: string; text: string }[] } }
    ).result.replies;
    expect(replies.map((r) => r.messageId)).toEqual([avatar, plain]);
    // Read back in the grammar the agent writes: a linked person by name.
    expect(replies[0]!.text).toBe("second answer @[Olive Owner]");

    const read = calls.find((c) => c.method === "conversations.replies")!;
    expect(read.form.get("channel")).toBe(CHANNEL);
    expect(read.form.get("ts")).toBe(ROOT);
  });

  it("walks a long thread to its newest end", async () => {
    const stage = await seedStage("long");
    const now = Date.now();
    messages = [{ ts: ROOT, user: "U0HUMAN", text: "q" }];
    for (let i = 0; i < 450; i++) {
      messages.push({
        ts: tsAgo(now, 3_600_000 - i * 1000),
        user: "U0HUMAN",
        text: `chatter ${i}`,
      });
    }
    const newest = tsAgo(now, 5_000);
    messages.push({
      ts: newest,
      app_id: stage.appId,
      text: "the newest reply",
    });

    const res = await tool(stage, "list_my_replies", {});
    expect(res).toMatchObject({
      ok: true,
      result: { replies: [{ messageId: newest, text: "the newest reply" }] },
    });
    expect(
      calls.filter((c) => c.method === "conversations.replies").length,
    ).toBeGreaterThan(1);
  });

  it("edits like an answer: mrkdwn, escaped broadcasts, resolved mentions, audited without text", async () => {
    const stage = await seedStage("edit");
    const now = Date.now();
    const mine = tsAgo(now, 60_000);
    messages = [
      { ts: ROOT, user: "U0HUMAN", text: "q" },
      { ts: mine, app_id: stage.appId, subtype: "bot_message", text: "wrong" },
    ];

    const res = await tool(stage, "edit_my_reply", {
      messageId: mine,
      text: "**Fixed** for @[Olive Owner] <!channel>",
    });
    expect(res).toEqual({
      ok: true,
      result: { status: "edited", messageId: mine },
    });
    const update = calls.find((c) => c.method === "chat.update")!;
    expect(update.form.get("channel")).toBe(CHANNEL);
    expect(update.form.get("ts")).toBe(mine);
    expect(update.form.get("text")).toBe(
      "*Fixed* for <@U0OLIVE> &lt;!channel&gt;",
    );
    // The exact-message read is bounded to that one message.
    const lookup = calls.find(
      (c) => c.method === "conversations.replies" && c.form.get("latest"),
    )!;
    expect(lookup.form.get("oldest")).toBe(mine);
    expect(lookup.form.get("inclusive")).toBe("true");

    const audit = await db.auditLog.findFirstOrThrow({
      where: { userId: OWNER, action: "update", service: "channel" },
    });
    expect(audit.metadata).toMatchObject({
      presenceId: stage.presenceId,
      messageId: mine,
      agentId: stage.agentId,
      viaAgent: "true",
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("Fixed");
  });

  it("in a threaded DM, reads and changes the thread it answered in", async () => {
    const dmThread = "1793000500.000100";
    const stage = await seedStage("dmthread", {
      kind: "direct",
      sourceThreadId: dmThread,
    });
    const now = Date.now();
    const inThread = tsAgo(now, 30_000);
    messages = [
      { ts: dmThread, user: "U0HUMAN", text: "the DM thread's question" },
      { ts: inThread, app_id: stage.appId, text: "answer in the DM thread" },
    ];
    const list = await tool(stage, "list_my_replies", {});
    expect(list).toMatchObject({
      ok: true,
      result: { replies: [{ messageId: inThread }] },
    });
    const read = calls.find((c) => c.method === "conversations.replies")!;
    expect(read.form.get("channel")).toBe(DM);
    expect(read.form.get("ts")).toBe(dmThread);
    expect(calls.some((c) => c.method === "conversations.history")).toBe(false);

    const del = await tool(stage, "delete_my_reply", { messageId: inThread });
    expect(del).toMatchObject({ ok: true });
    const write = calls.find((c) => c.method === "chat.delete")!;
    expect(write.form.get("channel")).toBe(DM);
    expect(write.form.get("ts")).toBe(inThread);
  });

  it("deletes its own reply in a DM, audited", async () => {
    const stage = await seedStage("dm", { kind: "direct" });
    const mine = tsAgo(Date.now(), 60_000);
    messages = [{ ts: mine, app_id: stage.appId, text: "take this back" }];

    const res = await tool(stage, "delete_my_reply", { messageId: mine });
    expect(res).toEqual({
      ok: true,
      result: { status: "deleted", messageId: mine },
    });
    const del = calls.find((c) => c.method === "chat.delete")!;
    expect(del.form.get("channel")).toBe(DM);
    expect(del.form.get("ts")).toBe(mine);
    expect(
      await db.auditLog.count({
        where: { userId: OWNER, action: "delete", service: "channel" },
      }),
    ).toBe(1);
  });

  it("refuses a person's message, a card, a mirror, an old reply and an unknown id, with no Slack write", async () => {
    const stage = await seedStage("fence");
    const now = Date.now();
    const human = tsAgo(now, 60_000);
    const card = tsAgo(now, 50_000);
    const mirror = tsAgo(now, 40_000);
    const old = tsAgo(now, 25 * 60 * 60 * 1000);
    messages = [
      { ts: ROOT, user: "U0HUMAN", text: "q" },
      { ts: human, user: "U0HUMAN", text: "a person's words" },
      {
        ts: card,
        app_id: stage.appId,
        text: "Approve?",
        blocks: [{ type: "actions" }],
      },
      {
        ts: mirror,
        app_id: stage.appId,
        text: "_(:globe_with_meridians:)_ from the web",
      },
      { ts: old, app_id: stage.appId, text: "old reply" },
    ];
    for (const messageId of [human, card, mirror, old, "1793999999.000001"]) {
      for (const [name, args] of [
        ["edit_my_reply", { messageId, text: "x" }],
        ["delete_my_reply", { messageId }],
      ] as const) {
        const res = await tool(stage, name, args);
        expect(res).toMatchObject({ ok: false });
        expect((res as { error: string }).error).toMatch(
          /isn't one of your own replies/,
        );
      }
    }
    expect(writes()).toHaveLength(0);
  });

  it("works while approvals are paused (needs_attention), never on a removed app", async () => {
    const paused = await seedStage("paused", { status: "needs_attention" });
    messages = [{ ts: ROOT, user: "U0HUMAN", text: "q" }];
    expect(await tool(paused, "list_my_replies", {})).toMatchObject({
      ok: true,
    });
    const removed = await seedStage("removed", { status: "disabled" });
    calls.length = 0;
    const res = await tool(removed, "list_my_replies", {});
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/was removed/);
    expect(calls).toHaveLength(0);
  });

  it("refuses outside a linked conversation, and another agent's conversation", async () => {
    const a = await seedStage("mine");
    const b = await seedStage("theirs");
    const none = await tool(a, "list_my_replies", {}, null);
    expect(none).toMatchObject({ ok: false });
    expect((none as { error: string }).error).toMatch(/there is none here/);
    // A forged context (another agent's conversation) resolves to none.
    const forged = await tool(a, "list_my_replies", {}, b.conversationId);
    expect(forged).toMatchObject({ ok: false });
    expect((forged as { error: string }).error).toMatch(/there is none here/);
    expect(calls).toHaveLength(0);
  });

  it("a revoked token flips Slack to lost (the bell alert) and says so", async () => {
    const stage = await seedStage("dead");
    methodErrors.set("*", "token_revoked");
    const res = await tool(stage, "list_my_replies", {});
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(
      /removed from the workspace/,
    );
    const row = await db.agentChannel.findUniqueOrThrow({
      where: { id: stage.presenceId },
    });
    expect(row.status).toBe("disabled");
  });

  it("any other Slack refusal names the code and says not to retry", async () => {
    const stage = await seedStage("refused");
    const mine = tsAgo(Date.now(), 60_000);
    messages = [
      { ts: ROOT, user: "U0HUMAN", text: "q" },
      { ts: mine, app_id: stage.appId, text: "reply" },
    ];
    methodErrors.set("chat.delete", "cant_delete_message");
    const res = await tool(stage, "delete_my_reply", { messageId: mine });
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(
      /Slack refused the change \(cant_delete_message\)\. Nothing was changed\. Don't retry/,
    );
    expect(
      await db.auditLog.count({ where: { userId: OWNER, action: "delete" } }),
    ).toBe(0);
    const row = await db.agentChannel.findUniqueOrThrow({
      where: { id: stage.presenceId },
    });
    expect(row.status).toBe("active");
  });

  it("lists only its replies from the last day: no join notice, no old thread parent, long text cut", async () => {
    const parentTs = tsAgo(Date.now(), 2 * 24 * 60 * 60 * 1000);
    const stage = await seedStage("window", {
      externalThreadId: `${CHANNEL}:${parentTs}`,
    });
    const now = Date.now();
    const long = tsAgo(now, 30_000);
    messages = [
      // The agent started this thread two days ago: Slack returns the
      // parent on every page, whatever `oldest` says.
      { ts: parentTs, app_id: stage.appId, text: "the old opener" },
      {
        ts: tsAgo(now, 60_000),
        app_id: stage.appId,
        user: BOT_USER,
        subtype: "channel_join",
        text: "<@U0BOTSELF> has joined the channel",
      },
      { ts: long, app_id: stage.appId, text: "x".repeat(2_500) },
    ];
    const res = await tool(stage, "list_my_replies", {});
    const replies = (
      res as { result: { replies: { messageId: string; text: string }[] } }
    ).result.replies;
    expect(replies.map((r) => r.messageId)).toEqual([long]);
    expect(replies[0]!.text).toBe(`${"x".repeat(2_000)}… [truncated]`);
  });

  it("in a point-of-contact room thread, changes exactly the reply named, never the thread's opener", async () => {
    const opener = tsAgo(Date.now(), 120_000);
    const stage = await seedStage("room", {
      // A room link names the channel only; the turn names the thread.
      externalThreadId: CHANNEL,
      sourceThreadId: opener,
    });
    const now = Date.now();
    const mine = tsAgo(now, 30_000);
    const theirs = tsAgo(now, 60_000);
    messages = [
      // The agent opened this thread itself: the opener is its own plain
      // reply too, and Slack leads every thread page with it.
      { ts: opener, app_id: stage.appId, text: "room opener" },
      { ts: theirs, user: "U0HUMAN", text: "a person's answer" },
      { ts: mine, app_id: stage.appId, text: "the reply to change" },
    ];
    // The opener never vouches for another id: a person's reply, or an id
    // not in the thread at all, is refused before Slack is asked.
    for (const messageId of [theirs, "1793999999.000001"]) {
      const refused = await tool(stage, "delete_my_reply", { messageId });
      expect((refused as { error: string }).error).toMatch(
        /isn't one of your own replies/,
      );
    }
    expect(writes()).toHaveLength(0);

    const res = await tool(stage, "delete_my_reply", { messageId: mine });
    expect(res).toMatchObject({ ok: true });
    const lookup = calls.find(
      (c) => c.method === "conversations.replies" && c.form.get("latest"),
    )!;
    expect(lookup.form.get("ts")).toBe(opener);
    const del = calls.find((c) => c.method === "chat.delete")!;
    expect(del.form.get("channel")).toBe(CHANNEL);
    expect(del.form.get("ts")).toBe(mine);
  });

  it("refuses on a detached app, with no Slack call", async () => {
    const stage = await seedStage("detached", { status: "pending_setup" });
    const res = await tool(stage, "list_my_replies", {});
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/isn't connected/);
    expect(calls).toHaveLength(0);
  });

  it("refuses malformed calls before anything is read", async () => {
    const stage = await seedStage("args");
    for (const [name, args] of [
      ["list_my_replies", { channel: "C0OTHER" }],
      ["edit_my_reply", { messageId: "not-a-ts", text: "x" }],
      ["edit_my_reply", { messageId: "1793000000.000200", text: "  " }],
      ["delete_my_reply", { messageId: "1793000000.000200", channel: "C0X" }],
    ] as const) {
      expect(await tool(stage, name, args)).toMatchObject({ ok: false });
    }
    expect(calls).toHaveLength(0);
  });
});

describe.skipIf(!PROOF_URL)("the agent's own replies (service fence)", () => {
  it("another agent's conversation and turn read as nothing, in the query itself", async () => {
    const a = await seedStage("fence-a");
    const b = await seedStage("fence-b", {
      sourceThreadId: "1793000900.000100",
    });
    const mine = tsAgo(Date.now(), 30_000);
    messages = [
      { ts: ROOT, user: "U0HUMAN", text: "q" },
      { ts: mine, app_id: a.appId, text: "a's reply" },
    ];
    // B's conversation under A's identity: nothing to act on.
    await expect(
      service.listOwnReplies({
        agentId: a.agentId,
        conversationId: b.conversationId,
        turnId: null,
      }),
    ).rejects.toThrow(/isn't in a chat app/);
    // B's turn (in a thread) never narrows A's conversation.
    await service.listOwnReplies({
      agentId: a.agentId,
      conversationId: a.conversationId,
      turnId: b.turnId,
    });
    const read = calls.find((c) => c.method === "conversations.replies")!;
    expect(read.form.get("ts")).toBe(ROOT);
    expect(writes()).toHaveLength(0);
  });
});
