import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { proofDatabaseUrl } from "../../testing/pg-proof";

/**
 * send_message proofs — the 4c capability end to end against a real DB and
 * a fake Slack: resolve → guard → hold/send → decide → deliver.
 *
 * The properties pinned:
 *  - an undecided recipient HOLDS (ask-by-default): no wire post happens
 *    until the owner approves; approve delivers exactly the frozen text
 *    to exactly the frozen recipient (row-is-truth, inherited from 4b);
 *  - an `allow` contact sends immediately — no approval row at all;
 *  - `approve_always` executes AND flips the contact, so the next send to
 *    the same recipient skips the card entirely;
 *  - the flip records the decider; the dashboard revoke (policy back to
 *    `ask`) makes the next send hold again;
 *  - recipients resolve id-anchored: an anchor from find_recipient makes
 *    an unlinked person sendable, and an unknown name errors actionably;
 *  - channels resolve by exact name; a person send opens the DM first;
 *  - tenancy: a foreign workspace's contact flip reads not-found.
 */

const PROOF_URL = proofDatabaseUrl();

const P = "smp-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WORKSPACE = `${P}ws`;
const OTHER_WORKSPACE = `${P}other-ws`;
const OWNER = `${P}owner`;
const TENANT = "T-SMP";

let db: typeof import("@onecli/db").db;
let send: typeof import("./send-message-service");
let approvals: typeof import("./action-approval-service");
let search: typeof import("./recipient-search-service");

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
        const body = handler ? handler(call) : {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...(body as object) }));
      });
    });
    slackServer.listen(0, "127.0.0.1", () => {
      const { port } = slackServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

const scriptSlack = () => {
  slackCalls = [];
  slackHandlers = {};
  slackHandlers["conversations.open"] = (call) => ({
    channel: { id: `D-IM-${call.form.get("users")}` },
  });
  slackHandlers["chat.postMessage"] = () => ({
    channel: "D-POSTED",
    ts: "777.111",
  });
  slackHandlers["chat.update"] = () => ({ ts: "777.111" });
  slackHandlers["users.info"] = (call) => ({
    user: {
      id: call.form.get("user"),
      team_id: TENANT,
      name: "owner",
      profile: { display_name: "Owner" },
    },
  });
};

// ── Seeds (the action-approval suite's shapes, prefix-fenced) ──────────────

let seq = 0;

/** One integration per org (unique on organization+provider) — created
 * lazily on first use, shared by every stage. */
let sharedIntegrationId: string | null = null;
const integrationOf = async (): Promise<string> => {
  if (sharedIntegrationId) return sharedIntegrationId;
  const integration = await db.channelIntegration.create({
    data: {
      organizationId: ORG,
      provider: "slack",
      externalId: TENANT,
      name: "SMP Workspace",
      createdByUserId: OWNER,
    },
    select: { id: true },
  });
  sharedIntegrationId = integration.id;
  return integration.id;
};

const seedStage = async (suffix: string) => {
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `smp agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  const integration = { id: await integrationOf() };
  const { getCrypto } = await import("../../providers");
  const credentials = await getCrypto().encrypt(
    JSON.stringify({ botToken: "xoxb-smp-test" }),
  );
  seq += 1;
  const presence = await db.agentChannel.create({
    data: {
      agentId: agent.id,
      integrationId: integration.id,
      provider: "slack",
      externalId: `${P}bot-${seq}`,
      identityRef: `${P}identity-${seq}`,
      transport: "socket",
      status: "active",
      credentials,
    },
    select: { id: true },
  });
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
  await db.workspaceAccess.upsert({
    where: { workspaceId_userId: { workspaceId: WORKSPACE, userId: OWNER } },
    create: { workspaceId: WORKSPACE, userId: OWNER, role: "owner" },
    update: { role: "owner" },
  });
  const conversation = await db.conversation.create({
    data: { agentId: agent.id, source: "slack", externalRef: `${P}${suffix}` },
    select: { id: true },
  });
  const turn = await db.turn.create({
    data: {
      conversationId: conversation.id,
      message: "send it please",
      status: "done",
      source: "slack",
      finishedAt: new Date(),
    },
    select: { id: true },
  });
  return {
    agentId: agent.id,
    integrationId: integration.id,
    presenceId: presence.id,
    conversationId: conversation.id,
    turnId: turn.id,
  };
};

const reset = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  sharedIntegrationId = null;
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.SLACK_API_BASE_URL = await startSlackFake();
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  ({ db } = await import("@onecli/db"));
  send = await import("./send-message-service");
  approvals = await import("./action-approval-service");
  search = await import("./recipient-search-service");

  await reset();
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.organizationMember.deleteMany({
    where: { userId: { startsWith: P } },
  });
  await db.workspaceAccess.deleteMany({ where: { userId: { startsWith: P } } });
  await db.workspace.deleteMany({
    where: { id: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.createMany({
    data: [
      { id: ORG, name: ORG, slug: ORG },
      { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
    ],
  });
  await db.workspace.createMany({
    data: [
      { id: WORKSPACE, name: "SMP", organizationId: ORG },
      { id: OTHER_WORKSPACE, name: "SMP Other", organizationId: OTHER_ORG },
    ],
  });
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.com`,
      externalAuthId: OWNER,
      name: "Olive Owner",
    },
  });
  await db.organizationMember.createMany({
    data: [
      {
        organizationId: ORG,
        userId: OWNER,
        userEmail: `${OWNER}@example.com`,
        role: "admin",
      },
    ],
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  slackServer?.close();
});

describe.skipIf(!PROOF_URL)("send_message (4c)", () => {
  it("holds for an undecided recipient, then approve delivers the FROZEN text to the FROZEN recipient", async () => {
    const stage = await seedStage("hold");
    scriptSlack();

    const outcome = await send.requestSend({
      agentId: stage.agentId,
      to: "Olive Owner",
      text: "the dashboard is ready",
      originConversationId: stage.conversationId,
      originTurnId: stage.turnId,
    });
    expect(outcome.kind).toBe("held");
    if (outcome.kind !== "held") throw new Error("unreachable");

    // NOTHING delivered yet — the only postMessage calls so far are the
    // owner card (D-IM… via conversations.open for the card's DM).
    const preDecide = slackCallsFor("chat.postMessage");
    const row = await db.actionApproval.findUniqueOrThrow({
      where: { id: outcome.approvalId },
    });
    expect(row.status).toBe("pending");
    expect(row.action).toBe(send.SEND_MESSAGE_ACTION);

    const decided = await approvals.decideActionApproval({
      approvalId: outcome.approvalId,
      decision: "approve",
      deciderUserId: OWNER,
    });
    expect(decided).toEqual({ kind: "decided", status: "executed" });

    // The delivery: exactly one NEW postMessage, to the recipient's DM,
    // with the frozen text.
    const posts = slackCallsFor("chat.postMessage").slice(preDecide.length);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.form.get("channel")).toBe("D-IM-U-OWNER");
    expect(posts[0]!.form.get("text")).toBe("the dashboard is ready");

    // Plain approve records NO contact: the next send asks again.
    expect(
      await db.agentContact.findFirst({ where: { agentId: stage.agentId } }),
    ).toBeNull();
  });

  it("approve_always delivers AND flips the contact - the next send skips the card", async () => {
    const stage = await seedStage("always");
    scriptSlack();

    const first = await send.requestSend({
      agentId: stage.agentId,
      to: "Olive Owner",
      text: "first ask",
      originConversationId: stage.conversationId,
      originTurnId: stage.turnId,
    });
    expect(first.kind).toBe("held");
    if (first.kind !== "held") throw new Error("unreachable");

    const decided = await approvals.decideActionApproval({
      approvalId: first.approvalId,
      decision: "approve_always",
      deciderUserId: OWNER,
    });
    expect(decided).toEqual({ kind: "decided", status: "executed" });

    // The standing grant exists, decider recorded.
    const contact = await db.agentContact.findFirstOrThrow({
      where: { agentId: stage.agentId, kind: "person" },
    });
    expect(contact.policy).toBe("allow");
    expect(contact.decidedByUserId).toBe(OWNER);

    // The SECOND send goes straight out: sent, no new approval row.
    const before = slackCallsFor("chat.postMessage").length;
    const second = await send.requestSend({
      agentId: stage.agentId,
      to: "Olive Owner",
      text: "second sails through",
      originConversationId: stage.conversationId,
      originTurnId: stage.turnId,
    });
    expect(second.kind).toBe("sent");
    expect(
      await db.actionApproval.count({
        where: { agentId: stage.agentId, status: "pending" },
      }),
    ).toBe(0);
    const posts = slackCallsFor("chat.postMessage").slice(before);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.form.get("text")).toBe("second sails through");
  });

  it("a dashboard revoke (allow → ask) makes the next send hold again", async () => {
    const stage = await seedStage("revoke");
    scriptSlack();

    await send.allowContact({
      agentId: stage.agentId,
      recipient: { kind: "person", ref: "U-OWNER", label: "Olive Owner" },
      deciderUserId: OWNER,
    });
    const contact = await db.agentContact.findFirstOrThrow({
      where: { agentId: stage.agentId },
      select: { id: true },
    });

    const flipped = await send.setContactPolicy({
      workspaceId: WORKSPACE,
      agentId: stage.agentId,
      contactId: contact.id,
      policy: "ask",
      deciderUserId: OWNER,
    });
    expect(flipped).toEqual({ id: contact.id, policy: "ask" });

    const outcome = await send.requestSend({
      agentId: stage.agentId,
      to: "Olive Owner",
      text: "asks again",
      originConversationId: stage.conversationId,
      originTurnId: stage.turnId,
    });
    expect(outcome.kind).toBe("held");
  });

  it("a FOREIGN workspace's contact flip reads not-found (tenancy fence)", async () => {
    const stage = await seedStage("tenancy");
    await send.allowContact({
      agentId: stage.agentId,
      recipient: { kind: "person", ref: "U-OWNER", label: "Olive Owner" },
      deciderUserId: OWNER,
    });
    const contact = await db.agentContact.findFirstOrThrow({
      where: { agentId: stage.agentId },
      select: { id: true },
    });
    const foreign = await send.setContactPolicy({
      workspaceId: OTHER_WORKSPACE,
      agentId: stage.agentId,
      contactId: contact.id,
      policy: "allow",
      deciderUserId: OWNER,
    });
    expect(foreign).toBeNull();
    expect(
      (
        await db.agentContact.findUniqueOrThrow({
          where: { id: contact.id },
        })
      ).policy,
    ).toBe("allow");
  });

  it("an anchored find_recipient pick makes an UNLINKED person sendable; unknown names error actionably", async () => {
    const stage = await seedStage("anchor");
    scriptSlack();

    // No link, no anchor: actionable refusal.
    await expect(
      send.requestSend({
        agentId: stage.agentId,
        to: "Toni Stranger",
        text: "hi",
        originConversationId: stage.conversationId,
        originTurnId: stage.turnId,
      }),
    ).rejects.toThrow(/find_recipient/);

    // The anchor (what a find_recipient pick records) makes them sendable —
    // id-bound to the provider id chosen at pick time. The model may write
    // the mention grammar it was taught (@[Name]) — accepted here too.
    await search.anchorRecipient({
      conversationId: stage.conversationId,
      name: "Toni Stranger",
      externalUserId: "U-STRANGER",
    });
    const outcome = await send.requestSend({
      agentId: stage.agentId,
      to: "@[Toni Stranger]",
      text: "hello from the agent",
      originConversationId: stage.conversationId,
      originTurnId: stage.turnId,
    });
    expect(outcome.kind).toBe("held");
    if (outcome.kind !== "held") throw new Error("unreachable");
    const row = await db.actionApproval.findUniqueOrThrow({
      where: { id: outcome.approvalId },
    });
    expect(row.payload).toMatchObject({
      to: { kind: "person", ref: "U-STRANGER" },
    });
  });

  it("a #channel send resolves by exact name and posts to the channel id (no DM open)", async () => {
    const stage = await seedStage("channel");
    scriptSlack();
    slackHandlers["conversations.list"] = () => ({
      channels: [
        { id: "C-PROJ", name: "proj-updates", is_member: true },
        { id: "C-OTHER", name: "proj-updates-archive", is_member: true },
      ],
    });

    await send.allowContact({
      agentId: stage.agentId,
      recipient: { kind: "channel", ref: "C-PROJ", label: "#proj-updates" },
      deciderUserId: OWNER,
    });
    const before = slackCallsFor("chat.postMessage").length;
    const outcome = await send.requestSend({
      agentId: stage.agentId,
      to: "#proj-updates",
      text: "weekly summary posted",
      originConversationId: stage.conversationId,
      originTurnId: stage.turnId,
    });
    expect(outcome.kind).toBe("sent");
    const posts = slackCallsFor("chat.postMessage").slice(before);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.form.get("channel")).toBe("C-PROJ");
  });
});
