import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { proofDatabaseUrl } from "../../testing/pg-proof";

/**
 * send_message with `files`: the agent sends files from its home into
 * ANOTHER conversation, driven through the real doors (the runner's staged
 * upload, then the send_message tool call, then the approval decide).
 *
 * The rules pinned here:
 *  - files always hold for a card, even where text is allowed; approve
 *    uploads them as one message (in the thread when one is named) and
 *    records the ledger row with its message ref;
 *  - Never refuses outright, deny uploads nothing;
 *  - an install without files:write refuses clearly, nothing posted;
 *  - staged files never show under the calling turn's reply;
 *  - sendAs "you" with files refuses; over the caps refuses before upload.
 */

const PROOF_URL = proofDatabaseUrl();
const P = "sfe-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OWNER = `${P}owner`;
const TEAM = "T0SFE";
const BOT_USER = "U0SFEBOT";
const APP = "A0SFE";
const ON = "C0SFEON";
const OFF = "C0SFEOFF";
const ASK = "C0SFEASK";

let db: typeof import("@onecli/db").db;
let tools: typeof import("../platform-tool-service");
let approvals: typeof import("./action-approval-service");
let attachments: typeof import("../attachment-service");
let turns: typeof import("../turn-service");
let providers: typeof import("../../providers");

// ── Fake Slack: chat + the three-step upload ──────────────────────────────
const calls: { method: string; form: URLSearchParams }[] = [];
const uploadedBytes: Buffer[] = [];
let uploadRefusal: string | null = null;
let tsSeq = 0;
const nextTs = () =>
  `${Math.floor(Date.now() / 1000)}.${String(++tsSeq).padStart(6, "0")}`;
/** file id → the channel and ts its share posted. */
const shares = new Map<string, { channel: string; ts: string }>();
let fileSeq = 0;
/** What the shares posted, as Slack's history would show them. */
const posted: {
  channel: string;
  ts: string;
  text: string;
  thread_ts?: string;
}[] = [];
let base = "";

const answer = (method: string, form: URLSearchParams): unknown => {
  switch (method) {
    case "conversations.list":
      return {
        ok: true,
        channels: [
          { id: ON, name: "proj-reports", is_member: true },
          { id: OFF, name: "off-room", is_member: true },
          { id: ASK, name: "ask-room", is_member: true },
        ],
      };
    case "users.conversations":
      return { ok: true, channels: [] };
    case "chat.postMessage":
      return { ok: true, channel: form.get("channel"), ts: nextTs() };
    case "files.getUploadURLExternal": {
      if (uploadRefusal) return { ok: false, error: uploadRefusal };
      const id = `F${++fileSeq}`;
      return { ok: true, upload_url: `${base}/upload/${id}`, file_id: id };
    }
    case "files.completeUploadExternal": {
      const files = JSON.parse(form.get("files") ?? "[]") as { id: string }[];
      const channel = form.get("channel_id") ?? "";
      const ts = nextTs();
      for (const f of files) shares.set(f.id, { channel, ts });
      posted.push({
        channel,
        ts,
        text: form.get("initial_comment") ?? "",
        ...(form.get("thread_ts") && { thread_ts: form.get("thread_ts")! }),
      });
      return { ok: true, files: files.map((f) => ({ id: f.id })) };
    }
    case "files.info": {
      const share = shares.get(form.get("file") ?? "");
      return {
        ok: true,
        file: {
          shares: share
            ? { public: { [share.channel]: [{ ts: share.ts }] } }
            : {},
        },
      };
    }
    case "conversations.history":
      return {
        ok: true,
        messages: posted
          .filter((m) => m.channel === form.get("channel") && !m.thread_ts)
          .map((m) => ({ ...m, user: BOT_USER, subtype: "file_share" })),
        has_more: false,
      };
    case "conversations.replies": {
      const root = form.get("ts");
      const channel = form.get("channel");
      return {
        ok: true,
        messages: posted
          .filter(
            (m) =>
              m.channel === channel && (m.ts === root || m.thread_ts === root),
          )
          .map((m) => ({ ...m, user: BOT_USER, subtype: "file_share" })),
        has_more: false,
        response_metadata: { next_cursor: "" },
      };
    }
    default:
      return { ok: true };
  }
};

let slackServer: Server;
const startSlackFake = (): Promise<string> =>
  new Promise((resolve) => {
    slackServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const url = req.url ?? "/";
        if (url.startsWith("/upload/")) {
          uploadedBytes.push(Buffer.concat(chunks));
          res.writeHead(200);
          res.end("OK");
          return;
        }
        const method = url.slice(1);
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
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
const nothingPosted = () =>
  callsOf("chat.postMessage").length === 0 &&
  callsOf("files.getUploadURLExternal").length === 0 &&
  callsOf("files.completeUploadExternal").length === 0 &&
  uploadedBytes.length === 0;

// ── Seeds ─────────────────────────────────────────────────────────────────
let integrationId: string;

interface Stage {
  agentId: string;
  presenceId: string;
  conversationId: string;
  turnId: string;
  runnerId: string;
  sandboxId: string;
}

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
      externalId: `${APP}-${suffix}`,
      identityRef: BOT_USER,
      transport: "socket",
      status: "active",
      credentials,
    },
    select: { id: true },
  });
  const conversation = await db.conversation.create({
    data: {
      agentId: agent.id,
      source: "web",
      userId: OWNER,
      direct: true,
    },
    select: { id: true },
  });
  const turn = await db.turn.create({
    data: {
      conversationId: conversation.id,
      userId: OWNER,
      message: "send the report to #proj-reports",
      status: "running",
      source: "web",
    },
    select: { id: true },
  });
  const runnerId = `${P}runner-${suffix}`;
  const sandboxId = `${P}sb-${suffix}`;
  await db.runner.create({
    data: { id: runnerId, name: "runner", token: `rnr_${P}${suffix}` },
  });
  await db.sandbox.create({
    data: { id: sandboxId, agentId: agent.id, runnerId, status: "running" },
  });
  for (const [ref, state] of [
    [ON, "approved"],
    [OFF, "blocked"],
  ] as const) {
    await db.agentReachGrant.create({
      data: {
        agentId: agent.id,
        integrationId,
        provider: "slack",
        subjectKind: "space",
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
    conversationId: conversation.id,
    turnId: turn.id,
    runnerId,
    sandboxId,
  };
};

/** The runner's staged upload (`file.part` with purpose "send"), through
 * the real service door. Answers the stored attachment id. */
const stage = async (
  s: Stage,
  name: string,
  content: string,
): Promise<string> => {
  const bytes = Buffer.from(content);
  const out = await tools.executeAttachmentUpload(
    s.runnerId,
    {
      sandboxId: s.sandboxId,
      conversationId: s.conversationId,
      turnId: s.turnId,
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      purpose: "send",
    },
    "text/csv",
    bytes,
  );
  if (!out.ok || !out.attachmentId) throw new Error(out.error ?? "no id");
  return out.attachmentId;
};

const tool = (s: Stage, name: string, args: unknown) =>
  tools.executePlatformTool(s.runnerId, {
    sandboxId: s.sandboxId,
    tool: name,
    args,
    conversationId: s.conversationId,
    turnId: s.turnId,
  });

const heldId = (result: unknown): string => {
  const r = result as { ok: boolean; result?: { status?: string } };
  expect(r).toMatchObject({ ok: true, result: { status: "held" } });
  return "";
};

const pendingApproval = (agentId: string) =>
  db.actionApproval.findFirstOrThrow({
    where: { agentId, status: "pending" },
  });

const reset = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  base = await startSlackFake();
  process.env.SLACK_API_BASE_URL = base;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  ({ db } = await import("@onecli/db"));
  providers = await import("../../providers");
  tools = await import("../platform-tool-service");
  approvals = await import("./action-approval-service");
  attachments = await import("../attachment-service");
  turns = await import("../turn-service");
  const store = await import("../../providers/attachment-store");
  const pgStore = await import("../attachments/pg-blob-store");
  store.initAttachmentStore(pgStore.pgAttachmentBlobStore);

  await reset();
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "SFE", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.com`,
      externalAuthId: OWNER,
      name: "Olive Owner",
    },
  });
  // A workspace owner: may also change the agent's posts in a channel from
  // their own chat (own-replies' asker rule), which the ledger test uses.
  await db.workspaceAccess.create({
    data: { workspaceId: WORKSPACE, userId: OWNER, role: "owner" },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: OWNER,
      userEmail: `${OWNER}@example.com`,
      role: "owner",
    },
  });
  integrationId = (
    await db.channelIntegration.create({
      data: {
        organizationId: ORG,
        provider: "slack",
        externalId: TEAM,
        name: "SFE Slack",
        createdByUserId: OWNER,
      },
      select: { id: true },
    })
  ).id;
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await reset();
  calls.length = 0;
  uploadedBytes.length = 0;
  shares.clear();
  posted.length = 0;
  uploadRefusal = null;
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  slackServer?.close();
});

describe.skipIf(!PROOF_URL)("send_message with files", () => {
  it("an allowed channel still holds; approve uploads once as one message and records the ledger row", async () => {
    const s = await seedStage("allowed");
    const id = await stage(s, "report.csv", "a,b\n1,2\n");
    const result = await tool(s, "send_message", {
      to: "#proj-reports",
      text: "Here is the report",
      attachmentIds: [id],
    });
    heldId(result);
    // Held: nothing left the platform yet.
    expect(nothingPosted()).toBe(true);
    const approval = await pendingApproval(s.agentId);
    expect(approval.action).toBe("channel.send_files");
    expect(approval.summary).toContain("report.csv (8B)");
    expect(approval.summary).toContain("Here is the report");

    const decided = await approvals.decideActionApproval({
      approvalId: approval.id,
      decision: "approve",
      deciderUserId: OWNER,
    });
    expect(decided).toMatchObject({ kind: "decided", status: "executed" });
    const [complete] = callsOf("files.completeUploadExternal");
    expect(complete?.form.get("channel_id")).toBe(ON);
    expect(complete?.form.get("thread_ts")).toBeNull();
    expect(complete?.form.get("initial_comment")).toBe("Here is the report");
    expect(uploadedBytes.map((b) => b.toString())).toEqual(["a,b\n1,2\n"]);
    expect(callsOf("chat.postMessage")).toHaveLength(0);

    const share = [...shares.values()][0]!;
    const row = await db.channelSentMessage.findFirstOrThrow({
      where: { agentChannelId: s.presenceId },
    });
    expect(row.messageRef).toBe(share.ts);
    expect(row.externalThreadId).toBe(`${ON}:${share.ts}`);
    // Spent: the staged row keeps its count, its bytes are gone.
    const att = await db.conversationAttachment.findUniqueOrThrow({
      where: { id },
    });
    expect(att.status).toBe("sent");
    expect(att.data).toBeNull();

    // And list_my_replies finds it there, through the send ledger.
    const listed = await tool(s, "list_my_replies", {
      conversation: "#proj-reports",
    });
    expect(listed).toMatchObject({
      ok: true,
      result: { replies: [expect.objectContaining({ messageId: share.ts })] },
    });
  });

  it("a named thread: the files land in that thread's ROOT, even when the link names a reply", async () => {
    const s = await seedStage("thread");
    const id = await stage(s, "clip.txt", "hello");
    // An existing thread in the channel: its root and one reply in it.
    const root = "1781870000.123579";
    const reply = "1781870050.000001";
    posted.push(
      { channel: ON, ts: root, text: "kickoff" },
      { channel: ON, ts: reply, text: "a reply", thread_ts: root },
    );
    await tool(s, "send_message", {
      to: "#proj-reports",
      text: "in thread",
      // A reply's own link, without thread_ts: Slack's rule says post to the
      // parent (MUTATION-PROOF: share with the raw ts and this reads it).
      thread: `https://wsc.slack.com/archives/${ON}/p${reply.replace(".", "")}`,
      attachmentIds: [id],
    });
    const approval = await pendingApproval(s.agentId);
    await approvals.decideActionApproval({
      approvalId: approval.id,
      decision: "approve",
      deciderUserId: OWNER,
    });
    const [complete] = callsOf("files.completeUploadExternal");
    expect(complete?.form.get("thread_ts")).toBe(root);
    const row = await db.channelSentMessage.findFirstOrThrow({
      where: { agentChannelId: s.presenceId },
    });
    expect(row.externalThreadId).toBe(`${ON}:${root}`);
  });

  it("a Never channel refuses outright: no card, nothing uploaded", async () => {
    const s = await seedStage("never");
    const id = await stage(s, "x.csv", "x");
    const result = await tool(s, "send_message", {
      to: "#off-room",
      text: "hi",
      attachmentIds: [id],
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Nothing was sent"),
    });
    expect(
      await db.actionApproval.count({ where: { agentId: s.agentId } }),
    ).toBe(0);
    expect(nothingPosted()).toBe(true);
  });

  it("a channel with no answer yet holds for the same files card", async () => {
    const s = await seedStage("ask");
    const id = await stage(s, "x.csv", "x");
    heldId(
      await tool(s, "send_message", {
        to: "#ask-room",
        text: "hi",
        attachmentIds: [id],
      }),
    );
    expect((await pendingApproval(s.agentId)).action).toBe(
      "channel.send_files",
    );
  });

  it("deny uploads nothing and deletes the staged file at once", async () => {
    const s = await seedStage("deny");
    const id = await stage(s, "x.csv", "x");
    // Another turn's staged file of the same agent: never touched by this
    // card's cleanup (the delete names only the frozen ids).
    const bystander = await stage(s, "keep.csv", "k");
    await tool(s, "send_message", {
      to: "#proj-reports",
      text: "hi",
      attachmentIds: [id],
    });
    const approval = await pendingApproval(s.agentId);
    await approvals.decideActionApproval({
      approvalId: approval.id,
      decision: "reject",
      deciderUserId: OWNER,
    });
    expect(nothingPosted()).toBe(true);
    expect(
      await db.channelSentMessage.count({
        where: { agentChannelId: s.presenceId },
      }),
    ).toBe(0);
    // Gone now, not after the 48h sweep. MUTATION-PROOF: drop the abandon
    // listener and the row is still staged here.
    expect(
      await db.conversationAttachment.findUnique({ where: { id } }),
    ).toBeNull();
    expect(
      (
        await db.conversationAttachment.findUniqueOrThrow({
          where: { id: bystander },
        })
      ).status,
    ).toBe("staged");
    // A reject is about this one send, never a standing Never.
    const grant = await db.agentReachGrant.findFirstOrThrow({
      where: { agentId: s.agentId, externalRef: ON },
    });
    expect(grant.state).toBe("approved");
  });

  it("an expired card uploads nothing and deletes its staged file at once", async () => {
    const s = await seedStage("expire");
    const id = await stage(s, "x.csv", "x");
    await tool(s, "send_message", {
      to: "#proj-reports",
      text: "hi",
      attachmentIds: [id],
    });
    const approval = await pendingApproval(s.agentId);
    expect(await approvals.expireActionApprovals([approval.id])).toBe(1);
    expect(nothingPosted()).toBe(true);
    expect(uploadedBytes).toHaveLength(0);
    // Gone now, not after the 48h sweep.
    expect(
      await db.conversationAttachment.findUnique({ where: { id } }),
    ).toBeNull();
  });

  it("a staged-file delete is fenced to its own agent", async () => {
    const s = await seedStage("fence-delete");
    const other = await seedStage("fence-delete-other");
    const theirs = await stage(other, "theirs.csv", "x");
    await attachments.deleteStagedAttachments(s.agentId, [theirs]);
    expect(
      (
        await db.conversationAttachment.findUniqueOrThrow({
          where: { id: theirs },
        })
      ).status,
    ).toBe("staged");
  });

  it("marking staged files sent is fenced to its own agent", async () => {
    const s = await seedStage("fence-sent");
    const other = await seedStage("fence-sent-other");
    const theirs = await stage(other, "theirs.csv", "x");
    await attachments.markStagedAttachmentsSent(s.agentId, [theirs]);
    const row = await db.conversationAttachment.findUniqueOrThrow({
      where: { id: theirs },
    });
    // Still the other agent's to send: status and bytes untouched.
    expect(row.status).toBe("staged");
    expect(row.data ?? row.storageRef).not.toBeNull();
  });

  it("a Never set after the card went out: approve uploads nothing and deletes the staged file", async () => {
    const s = await seedStage("never-later");
    const id = await stage(s, "x.csv", "x");
    await tool(s, "send_message", {
      to: "#proj-reports",
      text: "hi",
      attachmentIds: [id],
    });
    const approval = await pendingApproval(s.agentId);
    await db.agentReachGrant.updateMany({
      where: { agentId: s.agentId, externalRef: ON },
      data: { state: "blocked" },
    });
    const decided = await approvals.decideActionApproval({
      approvalId: approval.id,
      decision: "approve",
      deciderUserId: OWNER,
    });
    expect(decided).toMatchObject({ kind: "decided", status: "failed" });
    expect(nothingPosted()).toBe(true);
    expect(uploadedBytes).toHaveLength(0);
    expect(
      await db.conversationAttachment.findUnique({ where: { id } }),
    ).toBeNull();
  });

  it("a staged file gone before the approve (swept, conversation deleted): fails plainly, nothing posted", async () => {
    const s = await seedStage("gone");
    const kept = await stage(s, "a.csv", "a");
    const gone = await stage(s, "b.csv", "b");
    await tool(s, "send_message", {
      to: "#proj-reports",
      text: "hi",
      attachmentIds: [kept, gone],
    });
    const approval = await pendingApproval(s.agentId);
    await db.conversationAttachment.delete({ where: { id: gone } });
    const decided = await approvals.decideActionApproval({
      approvalId: approval.id,
      decision: "approve",
      deciderUserId: OWNER,
    });
    expect(decided).toMatchObject({ kind: "decided", status: "failed" });
    const row = await db.actionApproval.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(JSON.stringify(row)).toContain("The files are no longer available");
    // All or nothing: one missing file sends none of them.
    expect(nothingPosted()).toBe(true);
    expect(uploadedBytes).toHaveLength(0);
  });

  it("missing files:write: approve fails with the reinstall line, nothing posted", async () => {
    const s = await seedStage("scope");
    const id = await stage(s, "x.csv", "x");
    await tool(s, "send_message", {
      to: "#proj-reports",
      text: "hi",
      attachmentIds: [id],
    });
    uploadRefusal = "missing_scope";
    const approval = await pendingApproval(s.agentId);
    const decided = await approvals.decideActionApproval({
      approvalId: approval.id,
      decision: "approve",
      deciderUserId: OWNER,
    });
    expect(decided).toMatchObject({ kind: "decided", status: "failed" });
    const row = await db.actionApproval.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(JSON.stringify(row)).toContain(
      "needs the files:write permission; reinstall it",
    );
    expect(callsOf("files.completeUploadExternal")).toHaveLength(0);
    expect(callsOf("chat.postMessage")).toHaveLength(0);
    expect(uploadedBytes).toHaveLength(0);
    // Failed for good: the staged file is deleted with it.
    expect(
      await db.conversationAttachment.findUnique({ where: { id } }),
    ).toBeNull();
  });

  it("staged files never appear under the calling turn's reply (web turn payload)", async () => {
    const s = await seedStage("hidden");
    await stage(s, "secret-plan.csv", "x");
    const page = await turns.listTurns(WORKSPACE, s.conversationId, OWNER);
    const turn = page.turns.find((t) => t.id === s.turnId)!;
    expect(turn.attachments).toEqual([]);
  });

  it('sendAs "you" with files refuses plainly; nothing held or posted', async () => {
    const s = await seedStage("asyou");
    const id = await stage(s, "x.csv", "x");
    const result = await tool(s, "send_message", {
      to: "#proj-reports",
      text: "hi",
      sendAs: "you",
      attachmentIds: [id],
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "Sending files as you isn't supported yet; send them as Wes or without files",
      ),
    });
    expect(
      await db.actionApproval.count({ where: { agentId: s.agentId } }),
    ).toBe(0);
    expect(nothingPosted()).toBe(true);
  });

  it("the runner door: the x-onecli-file-purpose header stages the file; without it the file binds to the reply", async () => {
    const s = await seedStage("door");
    const { createApiApp } = await import("../../app");
    const app = createApiApp({ getSession: async () => null });
    const post = (name: string, extra: Record<string, string>) => {
      const bytes = Buffer.from(`bytes of ${name}`);
      return app.request("/v1/runner/attachments", {
        method: "POST",
        headers: {
          authorization: `Bearer rnr_${P}door`,
          "content-type": "text/csv",
          "x-onecli-sandbox-id": s.sandboxId,
          "x-onecli-conversation-id": s.conversationId,
          "x-onecli-turn-id": s.turnId,
          "x-onecli-file-name": encodeURIComponent(name),
          "x-onecli-file-sha256": createHash("sha256")
            .update(bytes)
            .digest("hex"),
          ...extra,
        },
        body: bytes,
      });
    };
    const staged = await post("staged.csv", {
      "x-onecli-file-purpose": "send",
    });
    const reply = await post("reply.csv", {});
    const unknown = await post("odd.csv", { "x-onecli-file-purpose": "reply" });
    const stagedBody = (await staged.json()) as { attachmentId: string };
    const replyBody = (await reply.json()) as { attachmentId: string };
    expect(
      (
        await db.conversationAttachment.findUniqueOrThrow({
          where: { id: stagedBody.attachmentId },
        })
      ).status,
    ).toBe("staged");
    expect(
      (
        await db.conversationAttachment.findUniqueOrThrow({
          where: { id: replyBody.attachmentId },
        })
      ).status,
    ).toBe("bound");
    // Only "send" is a purpose: anything else is a malformed request.
    expect(unknown.status).toBe(400);
  });

  it("over the per-turn count is refused at staging, before any send", async () => {
    const s = await seedStage("count");
    for (let i = 0; i < 10; i++) await stage(s, `f${i}.csv`, "x");
    await expect(stage(s, "f10.csv", "x")).rejects.toThrow(/at most 10 files/);
    expect(nothingPosted()).toBe(true);
  });

  it("over the size cap is refused at staging", async () => {
    const s = await seedStage("size");
    const big = "x".repeat(25 * 1024 * 1024 + 1);
    await expect(stage(s, "big.bin", big)).rejects.toThrow(/capped at 25MB/);
    expect(nothingPosted()).toBe(true);
  });

  it("another turn's staged file cannot be sent", async () => {
    const s = await seedStage("fence");
    const other = await seedStage("fence-other");
    const id = await stage(other, "theirs.csv", "x");
    const result = await tool(s, "send_message", {
      to: "#proj-reports",
      text: "hi",
      attachmentIds: [id],
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("can't be sent from here"),
    });
    expect(nothingPosted()).toBe(true);
  });
});
