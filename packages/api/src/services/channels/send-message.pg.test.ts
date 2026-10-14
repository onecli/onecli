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
 *  - tenancy: a foreign workspace's contact flip reads not-found;
 *  - every delivery is recorded where its reply will arrive, and the reply's
 *    turn is told what was sent and from where: once, only there, names only.
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
let platformTools: typeof import("../platform-tool-service");
let ingestion: typeof import("./channel-ingestion-service");
let turnContext: typeof import("../turn-context-service");
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
  // Slack answers with the channel it posted into (the IM's D… id for a
  // DM) and the new message's ts.
  slackHandlers["chat.postMessage"] = (call) => ({
    channel: call.form.get("channel"),
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
  platformTools = await import("../platform-tool-service");
  ingestion = await import("./channel-ingestion-service");
  turnContext = await import("../turn-context-service");
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
  it("the FIRST message to a person opens with a platform intro; the second does not", async () => {
    // A DM from a bot nobody has met reads as noise; the platform says who
    // is writing and for whom, once.
    const stage = await seedStage("intro");
    await db.agentChannel.update({
      where: { id: stage.presenceId },
      data: { createdByUserId: OWNER },
    });
    scriptSlack();
    await search.anchorRecipient({
      conversationId: stage.conversationId,
      name: "Dana Guest",
      externalUserId: "U-DANA",
    });
    const sendTo = async (text: string) => {
      const out = await send.requestSend({
        agentId: stage.agentId,
        to: "Dana Guest",
        text,
        originConversationId: stage.conversationId,
        originTurnId: stage.turnId,
      });
      if (out.kind !== "held") throw new Error("unreachable");
      await approvals.decideActionApproval({
        approvalId: out.approvalId,
        decision: "approve",
        deciderUserId: OWNER,
      });
      return slackCallsFor("chat.postMessage").at(-1)?.form.get("text") ?? "";
    };

    const first = await sendTo("what time today?");
    expect(first).toContain("an AI agent working for Olive Owner");
    expect(first).toContain("You can reply right here");
    expect(first).toContain("what time today?");

    const second = await sendTo("any update?");
    expect(second).not.toContain("an AI agent");
    expect(second).toContain("any update?");

    // Approving the send also lets Dana reply: no second "approve this
    // person?" gate when she answers, recorded in the approver's name.
    const grant = await db.agentReachGrant.findFirstOrThrow({
      where: { agentId: stage.agentId, externalRef: "U-DANA" },
      select: { state: true, subjectKind: true, decidedByUserId: true },
    });
    expect(grant).toEqual({
      state: "approved",
      subjectKind: "external_user",
      decidedByUserId: OWNER,
    });
  });

  it("the intro names the manager by NAME only, and never goes to someone the agent already knows", async () => {
    const stage = await seedStage("intro-known");
    // A manager with no display name: the intro must not fall back to the
    // email address (the DM may reach someone outside the workspace).
    const NAMELESS = `${P}nameless`;
    await db.user.upsert({
      where: { id: NAMELESS },
      create: {
        id: NAMELESS,
        email: `${NAMELESS}@example.com`,
        externalAuthId: NAMELESS,
      },
      update: {},
    });
    await db.agentChannel.update({
      where: { id: stage.presenceId },
      data: { createdByUserId: NAMELESS },
    });
    scriptSlack();
    const sendTo = async (name: string, ref: string) => {
      await search.anchorRecipient({
        conversationId: stage.conversationId,
        name,
        externalUserId: ref,
      });
      const out = await send.requestSend({
        agentId: stage.agentId,
        to: name,
        text: "hello",
        originConversationId: stage.conversationId,
        originTurnId: stage.turnId,
      });
      if (out.kind !== "held") throw new Error("unreachable");
      await approvals.decideActionApproval({
        approvalId: out.approvalId,
        decision: "approve",
        deciderUserId: OWNER,
      });
      return slackCallsFor("chat.postMessage").at(-1)?.form.get("text") ?? "";
    };

    const fresh = await sendTo("Nia New", "U-NIA");
    expect(fresh).toContain("an AI agent. You can reply right here");
    expect(fresh).not.toContain("@example.com");

    // A teammate who already DMs the agent (a direct thread exists).
    await db.channelThreadLink.create({
      data: {
        agentChannelId: stage.presenceId,
        conversationId: (
          await db.conversation.create({
            data: {
              agentId: stage.agentId,
              source: "slack",
              externalRef: `${P}dm-tess`,
            },
            select: { id: true },
          })
        ).id,
        externalThreadId: "D-TESS",
        kind: "direct",
        externalUserId: "U-TESS",
      },
    });
    expect(await sendTo("Tess Teammate", "U-TESS")).not.toContain(
      "an AI agent",
    );

    // A person who already knocked (a reach row exists, still undecided).
    await db.agentReachGrant.create({
      data: {
        agentId: stage.agentId,
        integrationId: stage.integrationId,
        provider: "slack",
        subjectKind: "external_user",
        externalRef: "U-KAI",
        cardRefs: [],
      },
    });
    expect(await sendTo("Kai Knocker", "U-KAI")).not.toContain("an AI agent");
  });

  it("an always-allow send opens the reply lane in the ALLOWER's name; with no recorded allower, it opens nothing", async () => {
    const stage = await seedStage("allow-decider");
    // The presence was attached by someone OTHER than the allower: the
    // reach decision must never be recorded in the attacher's name.
    const ATTACHER = `${P}attacher`;
    await db.user.upsert({
      where: { id: ATTACHER },
      create: {
        id: ATTACHER,
        email: `${ATTACHER}@example.com`,
        externalAuthId: ATTACHER,
        name: "Attacher",
      },
      update: {},
    });
    await db.agentChannel.update({
      where: { id: stage.presenceId },
      data: { createdByUserId: ATTACHER },
    });
    scriptSlack();
    const sendAllowed = async (
      name: string,
      ref: string,
      decidedByUserId: string | null,
    ) => {
      await search.anchorRecipient({
        conversationId: stage.conversationId,
        name,
        externalUserId: ref,
      });
      await db.agentContact.create({
        data: {
          agentId: stage.agentId,
          kind: "person",
          externalRef: ref,
          displayName: name,
          policy: "allow",
          decidedByUserId,
        },
      });
      const out = await send.requestSend({
        agentId: stage.agentId,
        to: name,
        text: "hello",
        originConversationId: stage.conversationId,
        originTurnId: stage.turnId,
      });
      expect(out.kind).toBe("sent");
    };

    await sendAllowed("Ari Allowed", "U-ARI", OWNER);
    expect(
      await db.agentReachGrant.findFirstOrThrow({
        where: { agentId: stage.agentId, externalRef: "U-ARI" },
        select: { state: true, decidedByUserId: true },
      }),
    ).toEqual({ state: "approved", decidedByUserId: OWNER });

    await sendAllowed("Uma Unattributed", "U-UMA", null);
    expect(
      await db.agentReachGrant.count({
        where: { agentId: stage.agentId, externalRef: "U-UMA" },
      }),
    ).toBe(0);
  });

  it("a delivered send never overrides an explicit reach block", async () => {
    const stage = await seedStage("reach-blocked");
    scriptSlack();
    const presence = await db.agentChannel.findUniqueOrThrow({
      where: { id: stage.presenceId },
      select: { integrationId: true },
    });
    await db.agentReachGrant.create({
      data: {
        agentId: stage.agentId,
        integrationId: presence.integrationId,
        provider: "slack",
        subjectKind: "external_user",
        externalRef: "U-DANA",
        state: "blocked",
        cardRefs: [],
      },
    });
    await search.anchorRecipient({
      conversationId: stage.conversationId,
      name: "Dana Guest",
      externalUserId: "U-DANA",
    });
    const out = await send.requestSend({
      agentId: stage.agentId,
      to: "Dana Guest",
      text: "hello",
      originConversationId: stage.conversationId,
      originTurnId: stage.turnId,
    });
    if (out.kind !== "held") throw new Error("unreachable");
    await approvals.decideActionApproval({
      approvalId: out.approvalId,
      decision: "approve",
      deciderUserId: OWNER,
    });
    const grant = await db.agentReachGrant.findFirstOrThrow({
      where: { agentId: stage.agentId, externalRef: "U-DANA" },
      select: { state: true },
    });
    expect(grant.state).toBe("blocked");
  });

  it("a message to the agent's MANAGER goes straight out - no card asking them to approve themselves", async () => {
    // Relaying a colleague's answer back to the person who asked must not
    // hold for THAT person's approval.
    const stage = await seedStage("manager");
    await db.agentChannel.update({
      where: { id: stage.presenceId },
      data: { createdByUserId: OWNER },
    });
    scriptSlack();

    const outcome = await send.requestSend({
      agentId: stage.agentId,
      to: "Olive Owner",
      text: "Dana replied: in from now until the evening",
      originConversationId: stage.conversationId,
      originTurnId: stage.turnId,
    });

    expect(outcome.kind).toBe("sent");
    expect(
      await db.actionApproval.count({ where: { agentId: stage.agentId } }),
    ).toBe(0);
    const posts = slackCallsFor("chat.postMessage");
    expect(posts.at(-1)?.form.get("text")).toContain("Dana replied");
    // Nor a contact: an `ask` row would tell the dashboard the next message
    // to the manager asks first, and it never does.
    expect(
      await db.agentContact.count({ where: { agentId: stage.agentId } }),
    ).toBe(0);
  });

  it("the manager shortcut ends with the manager's access: a suspended member is asked like anyone", async () => {
    const stage = await seedStage("manager-suspended");
    await db.agentChannel.update({
      where: { id: stage.presenceId },
      data: { createdByUserId: OWNER },
    });
    await db.organizationMember.updateMany({
      where: { organizationId: ORG, userId: OWNER },
      data: { status: "suspended" },
    });
    scriptSlack();
    try {
      const outcome = await send.requestSend({
        agentId: stage.agentId,
        to: "Olive Owner",
        text: "should hold",
        originConversationId: stage.conversationId,
        originTurnId: stage.turnId,
      });
      expect(outcome.kind).toBe("held");
    } finally {
      await db.organizationMember.updateMany({
        where: { organizationId: ORG, userId: OWNER },
        data: { status: "active" },
      });
    }
  });

  it("a second send to someone whose first send still waits is NOT sent: one card, and the model hears it was dropped", async () => {
    // Two waiting cards for one recipient means approving both delivers
    // twice. One open ask per recipient; the second message is refused
    // honestly (not queued), so the agent can resend after the decision.
    const stage = await seedStage("dedupe");
    scriptSlack();
    const RUNNER = `${P}runner-dedupe`;
    await db.runner.deleteMany({ where: { id: RUNNER } });
    await db.runner.create({
      data: { id: RUNNER, name: "runner", token: `rnr_${P}dedupe` },
    });
    await db.sandbox.create({
      data: {
        id: `${P}sb-dedupe`,
        agentId: stage.agentId,
        runnerId: RUNNER,
        status: "running",
      },
    });
    const callSend = (text: string) =>
      platformTools.executePlatformTool(RUNNER, {
        sandboxId: `${P}sb-dedupe`,
        tool: "send_message",
        args: { to: "Olive Owner", text },
        conversationId: stage.conversationId,
        turnId: stage.turnId,
      });

    expect(await callSend("first question")).toMatchObject({
      ok: true,
      result: { status: "held" },
    });
    const cardsAfterFirst = slackCallsFor("chat.postMessage").length;
    const first = await db.actionApproval.findFirstOrThrow({
      where: { agentId: stage.agentId, status: "pending" },
      select: { id: true },
    });

    const second = await callSend("a different follow-up");
    expect(second).toMatchObject({
      ok: true,
      result: { status: "not_sent", to: "Olive Owner" },
    });
    expect(JSON.stringify(second)).toMatch(/dropped, not queued/);
    expect(
      await db.actionApproval.count({
        where: { agentId: stage.agentId, status: "pending" },
      }),
    ).toBe(1);
    expect(slackCallsFor("chat.postMessage")).toHaveLength(cardsAfterFirst);

    // Once the first is decided, a new send asks fresh.
    await approvals.decideActionApproval({
      approvalId: first.id,
      decision: "reject",
      deciderUserId: OWNER,
    });
    expect(await callSend("a different follow-up")).toMatchObject({
      ok: true,
      result: { status: "held" },
    });
    expect(
      await db.actionApproval.count({
        where: { agentId: stage.agentId, status: "pending" },
      }),
    ).toBe(1);
  });

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
    expect(decided).toMatchObject({ kind: "decided", status: "executed" });

    // The delivery: exactly one NEW postMessage, to the recipient's DM,
    // with the frozen text.
    const posts = slackCallsFor("chat.postMessage").slice(preDecide.length);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.form.get("channel")).toBe("D-IM-U-OWNER");
    // The frozen text, verbatim, after the first-contact intro line.
    expect(posts[0]!.form.get("text")).toMatch(
      /^_Hi, I'm .+, an AI agent\. You can reply right here\._\n\nthe dashboard is ready$/,
    );

    // Plain approve RECORDS the recipient (visible on Contacts) but grants
    // nothing: the row is `ask`, so the next send still asks.
    const recorded = await db.agentContact.findFirstOrThrow({
      where: { agentId: stage.agentId },
    });
    expect(recorded).toMatchObject({
      kind: "person",
      externalRef: "U-OWNER",
      displayName: "Olive Owner",
      policy: "ask",
    });
    const again = await send.requestSend({
      agentId: stage.agentId,
      to: "Olive Owner",
      text: "a second note",
      originConversationId: stage.conversationId,
      originTurnId: stage.turnId,
    });
    expect(again.kind).toBe("held");
  });

  it("a REJECTED send records no contact: only delivery adds someone", async () => {
    const stage = await seedStage("reject-nocontact");
    scriptSlack();
    const outcome = await send.requestSend({
      agentId: stage.agentId,
      to: "Olive Owner",
      text: "never sent",
      originConversationId: stage.conversationId,
      originTurnId: stage.turnId,
    });
    if (outcome.kind !== "held") throw new Error("unreachable");
    await approvals.decideActionApproval({
      approvalId: outcome.approvalId,
      decision: "reject",
      deciderUserId: OWNER,
    });
    expect(
      await db.agentContact.findFirst({ where: { agentId: stage.agentId } }),
    ).toBeNull();
  });

  it("delivery never overwrites a standing policy (allow stays allow)", async () => {
    const stage = await seedStage("keep-policy");
    scriptSlack();
    await send.allowContact({
      agentId: stage.agentId,
      recipient: { kind: "person", ref: "U-OWNER", label: "Olive Owner" },
      deciderUserId: OWNER,
    });
    const sent = await send.requestSend({
      agentId: stage.agentId,
      to: "Olive Owner",
      text: "goes straight out",
      originConversationId: stage.conversationId,
      originTurnId: stage.turnId,
    });
    expect(sent.kind).toBe("sent");
    const contact = await db.agentContact.findFirstOrThrow({
      where: { agentId: stage.agentId },
    });
    expect(contact.policy).toBe("allow");
    expect(contact.decidedByUserId).toBe(OWNER);
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
    expect(decided).toMatchObject({ kind: "decided", status: "executed" });

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

  it("a send Slack refuses with a DEAD-credential code flips the presence to disabled and tells the agent why; a rate limit flips nothing", async () => {
    // The outbound half of removal detection (plans/channel-aware-agents.md):
    // an app DELETED at api.slack.com sends us no webhook a per-agent app
    // can subscribe to, so the first call made with its dead token is where
    // the platform learns. `account_inactive` is what Slack documents for
    // "token is for a deleted user or workspace when using a bot token".
    // MUTATION-PROOF: drop `noteOutboundFailure` from executeSend and the
    // presence stays active / the error is the raw Slack code; widen
    // isDeadCredentialError to any code and the rate-limit control flips.
    const stage = await seedStage("dead");
    scriptSlack();
    slackHandlers["conversations.list"] = () => ({
      channels: [{ id: "C-DEAD", name: "dead-proj", is_member: true }],
    });
    await send.allowContact({
      agentId: stage.agentId,
      recipient: { kind: "channel", ref: "C-DEAD", label: "#dead-proj" },
      deciderUserId: OWNER,
    });

    // Control first: a transient refusal is the caller's error, not a removal.
    slackHandlers["chat.postMessage"] = () => ({
      ok: false,
      error: "ratelimited",
    });
    await expect(
      send.requestSend({
        agentId: stage.agentId,
        to: "#dead-proj",
        text: "first try",
        originConversationId: stage.conversationId,
        originTurnId: stage.turnId,
      }),
    ).rejects.toMatchObject({ code: "ratelimited" });
    expect(
      (
        await db.agentChannel.findUniqueOrThrow({
          where: { id: stage.presenceId },
          select: { status: true },
        })
      ).status,
    ).toBe("active");

    // The app is gone on Slack's side.
    slackHandlers["chat.postMessage"] = () => ({
      ok: false,
      error: "account_inactive",
    });
    await expect(
      send.requestSend({
        agentId: stage.agentId,
        to: "#dead-proj",
        text: "second try",
        originConversationId: stage.conversationId,
        originTurnId: stage.turnId,
      }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE",
      message: expect.stringContaining("Slack app was removed"),
    });
    const after = await db.agentChannel.findUniqueOrThrow({
      where: { id: stage.presenceId },
      select: { status: true, apiKeyId: true },
    });
    expect(after.status).toBe("disabled");
    expect(after.apiKeyId).toBeNull();

    // With the presence disabled there is nothing to send FROM: the next
    // request fails before reaching Slack at all.
    const postsBefore = slackCallsFor("chat.postMessage").length;
    await expect(
      send.requestSend({
        agentId: stage.agentId,
        to: "#dead-proj",
        text: "third try",
        originConversationId: stage.conversationId,
        originTurnId: stage.turnId,
      }),
    ).rejects.toThrow();
    expect(slackCallsFor("chat.postMessage").length).toBe(postsBefore);
  });

  it("through the REAL tool door, a removed app answers every messaging tool with the removal, never 'nobody matching' or 'no presence' — and a live twin restores the normal answers", async () => {
    // Found on a real api-server walk: after the app was deleted at Slack
    // and the presence flipped to `disabled`, a resumed session still lists
    // send_message/find_recipient (jcode unions tools), and the agent heard
    // "Nobody matching in the connected workspace." / "no active channel
    // presence" — both read as "keep looking". The removal must be named.
    const stage = await seedStage("removed-tools");
    const RUNNER = `${P}runner-removed-tools`;
    await db.runner.deleteMany({ where: { id: RUNNER } });
    await db.runner.create({
      data: { id: RUNNER, name: "runner", token: `rnr_${P}removed-tools` },
    });
    await db.sandbox.create({
      data: {
        id: `${P}sb-removed-tools`,
        agentId: stage.agentId,
        runnerId: RUNNER,
        status: "running",
      },
    });
    const call = (tool: string, args: unknown) =>
      platformTools.executePlatformTool(RUNNER, {
        sandboxId: `${P}sb-removed-tools`,
        tool,
        args,
        conversationId: stage.conversationId,
        turnId: stage.turnId,
      });

    // Control: alive → the ordinary answers (empty search, unknown person).
    slackHandlers["users.list"] = () => ({
      ok: true,
      members: [],
      response_metadata: { next_cursor: "" },
    });
    const aliveSearch = await call("find_recipient", { query: "moshe" });
    expect(aliveSearch.ok).toBe(true);
    const aliveSend = await call("send_message", { to: "Moshe", text: "hi" });
    expect(aliveSend.ok).toBe(false);
    expect(String((aliveSend as { error: string }).error)).not.toMatch(
      /removed from the workspace/,
    );

    // The app is gone: the presence reads disabled (the removal doors did
    // their work elsewhere; here we set the fact directly).
    await db.agentChannel.update({
      where: { id: stage.presenceId },
      data: { status: "disabled" },
    });
    const removedCopy =
      /Slack app was removed from the workspace.*re-attached.*Do not retry/s;
    for (const [tool, args] of [
      ["find_recipient", { query: "moshe" }],
      ["find_recipient", { query: "#general" }],
      ["send_message", { to: "Moshe", text: "hi" }],
      ["send_message", { to: "#general", text: "deploy done" }],
    ] as const) {
      const before = slackCalls.length;
      const result = await call(tool, args);
      expect(result.ok, `${tool} ${JSON.stringify(args)}`).toBe(false);
      expect((result as { error: string }).error).toMatch(removedCopy);
      // Nothing was asked of Slack: the dead token is never presented.
      expect(slackCalls.length).toBe(before);
    }

    // A LIVE presence NEXT TO the removed one wins: the removal is not
    // mentioned (there is a working app to use). (agentId, provider) is
    // unique, so the live twin is a second provider row — the shape a
    // Teams-and-Slack agent would have with one of the two uninstalled.
    const { getCrypto } = await import("../../providers");
    await db.agentChannel.create({
      data: {
        agentId: stage.agentId,
        integrationId: stage.integrationId,
        provider: "teams-e2e-twin",
        externalId: `${P}twin-app`,
        identityRef: `${P}twin-identity`,
        transport: "socket",
        status: "active",
        credentials: await getCrypto().encrypt(
          JSON.stringify({ botToken: "xoxb-twin" }),
        ),
      },
    });
    const withTwin = await call("send_message", { to: "Moshe", text: "hi" });
    expect(String((withTwin as { error?: string }).error ?? "")).not.toMatch(
      /removed from the workspace/,
    );
  });
});

describe.skipIf(!PROOF_URL)(
  "the reply side: a reply comes with what was sent, and from where",
  () => {
    /** Mark a turn as one the model actually ran (what `turn.started`
     * writes: the event row and `startedAt`). */
    const markRan = async (conversationId: string, turnId: string) => {
      const { lastSeq } = await db.conversation.update({
        where: { id: conversationId },
        data: { lastSeq: { increment: 1 } },
        select: { lastSeq: true },
      });
      await db.turnEvent.create({
        data: {
          conversationId,
          turnId,
          seq: lastSeq,
          type: "turn.started",
          payload: { type: "turn.started" },
        },
      });
      await db.turn.update({
        where: { id: turnId },
        data: { startedAt: new Date() },
      });
    };

    /** The recipient's own conversation, as the ingestion door builds it:
     * keyed by the reply address, with a thread link on the presence. */
    const replyConversation = async (
      agentId: string,
      presenceId: string,
      externalThreadId: string,
      kind: "direct" | "group" = "direct",
    ) => {
      const conversation = await db.conversation.create({
        data: { agentId, source: "slack", externalRef: externalThreadId },
        select: { id: true },
      });
      await db.channelThreadLink.create({
        data: {
          agentChannelId: presenceId,
          conversationId: conversation.id,
          externalThreadId,
          kind,
        },
      });
      return conversation.id;
    };

    const replyTurn = (conversationId: string, message = "yes, I'll be in") =>
      db.turn.create({
        data: { conversationId, message, status: "queued", source: "slack" },
        select: { id: true, createdAt: true },
      });

    /** One stage whose origin turn is the owner's, with Dana anchored. */
    const askingStage = async (suffix: string, originUserId = OWNER) => {
      const stage = await seedStage(suffix);
      await db.turn.update({
        where: { id: stage.turnId },
        data: { userId: originUserId },
      });
      scriptSlack();
      await search.anchorRecipient({
        conversationId: stage.conversationId,
        name: "Dana Guest",
        externalUserId: "U-DANA",
      });
      return stage;
    };

    const sendToDana = (
      stage: Awaited<ReturnType<typeof askingStage>>,
      text: string,
    ) =>
      send.requestSend({
        agentId: stage.agentId,
        to: "Dana Guest",
        text,
        originConversationId: stage.conversationId,
        originTurnId: stage.turnId,
      });

    const approve = async (outcome: Awaited<ReturnType<typeof sendToDana>>) => {
      if (outcome.kind !== "held") throw new Error(`held, got ${outcome.kind}`);
      await approvals.decideActionApproval({
        approvalId: outcome.approvalId,
        decision: "approve",
        deciderUserId: OWNER,
      });
      return outcome.approvalId;
    };

    it("an approved send: the reply hears what was sent and from where, and the frozen payload is untouched", async () => {
      const stage = await askingStage("relay-approved");
      const approvalId = await approve(
        await sendToDana(stage, "are you in the office tomorrow?"),
      );

      // The approval row keeps exactly what the owner approved.
      const row = await db.actionApproval.findUniqueOrThrow({
        where: { id: approvalId },
        select: { payload: true },
      });
      expect(row.payload).not.toHaveProperty("delivered");

      const dm = await replyConversation(
        stage.agentId,
        stage.presenceId,
        "D-IM-U-DANA",
      );
      const reply = await replyTurn(dm);
      const note = await send.buildSentContext(dm, reply.createdAt);
      expect(note).toContain(
        'From a conversation with Olive Owner, you sent Dana Guest: "are you in the office tomorrow?"',
      );
      expect(note).toContain("send_message");
    });

    it("an always-allow send is recorded too (no approval row), so its reply hears it", async () => {
      // MUTATION-PROOF: record only from the approval handler (the old
      // shape) and this note is null.
      const stage = await askingStage("relay-allow");
      await send.allowContact({
        agentId: stage.agentId,
        recipient: { kind: "person", ref: "U-DANA", label: "Dana Guest" },
        deciderUserId: OWNER,
      });
      const outcome = await sendToDana(stage, "can you join at 3?");
      expect(outcome.kind).toBe("sent");

      const dm = await replyConversation(
        stage.agentId,
        stage.presenceId,
        "D-IM-U-DANA",
      );
      const reply = await replyTurn(dm);
      expect(await send.buildSentContext(dm, reply.createdAt)).toContain(
        'From a conversation with Olive Owner, you sent Dana Guest: "can you join at 3?"',
      );
    });

    it("news for one RUN: a platform-written turn does not consume it; the model's next run does", async () => {
      const stage = await askingStage("relay-window");
      await approve(await sendToDana(stage, "is the demo still on?"));
      const dm = await replyConversation(
        stage.agentId,
        stage.presenceId,
        "D-IM-U-DANA",
      );

      // A record the platform wrote into the DM after the send (never ran a
      // model). MUTATION-PROOF: window on "any earlier turn" and the reply
      // below loses its note.
      await db.turn.create({
        data: {
          conversationId: dm,
          message: "[platform record]",
          status: "done",
          source: "greeting",
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      const reply = await replyTurn(dm);
      expect(await send.buildSentContext(dm, reply.createdAt)).toContain(
        "is the demo still on?",
      );

      // Once the model has run the reply, a later message is not re-told.
      await markRan(dm, reply.id);
      await db.turn.update({
        where: { id: reply.id },
        data: { status: "done", finishedAt: new Date() },
      });
      const later = await replyTurn(dm, "thanks!");
      expect(await send.buildSentContext(dm, later.createdAt)).toBeNull();

      // A send made AFTER a message was written cannot be what it answers.
      // MUTATION-PROOF: drop the `lte: before` bound and this reads it.
      await approve(await sendToDana(stage, "one more thing"));
      expect(await send.buildSentContext(dm, later.createdAt)).toBeNull();
    });

    it("only the recipient's own thread on the same presence: never another DM, another presence, or the asking conversation", async () => {
      const stage = await askingStage("relay-scope");
      await approve(await sendToDana(stage, "lunch on friday?"));

      const otherDm = await replyConversation(
        stage.agentId,
        stage.presenceId,
        "D-IM-U-OTHER",
      );
      const otherTurn = await replyTurn(otherDm, "hello");
      expect(
        await send.buildSentContext(otherDm, otherTurn.createdAt),
      ).toBeNull();

      // Another agent's app in the same Slack workspace sees the same D… id
      // shape; the presence half of the key keeps it out.
      const foreign = await seedStage("relay-scope-foreign");
      const foreignDm = await replyConversation(
        foreign.agentId,
        foreign.presenceId,
        "D-IM-U-DANA",
      );
      const foreignTurn = await replyTurn(foreignDm);
      expect(
        await send.buildSentContext(foreignDm, foreignTurn.createdAt),
      ).toBeNull();

      // The asking conversation does not hear its own send as news.
      expect(
        await send.buildSentContext(stage.conversationId, new Date()),
      ).toBeNull();
    });

    it("a channel post is recorded as the thread it roots, so a reply in that thread hears it", async () => {
      // MUTATION-PROOF: record the bare channel id (the old shape) and no
      // thread link ever matches.
      const stage = await askingStage("relay-channel");
      slackHandlers["conversations.list"] = () => ({
        channels: [{ id: "C-PROJ", name: "proj-updates", is_member: true }],
      });
      await send.allowContact({
        agentId: stage.agentId,
        recipient: { kind: "channel", ref: "C-PROJ", label: "#proj-updates" },
        deciderUserId: OWNER,
      });
      const outcome = await send.requestSend({
        agentId: stage.agentId,
        to: "#proj-updates",
        text: "who owns the release notes?",
        originConversationId: stage.conversationId,
        originTurnId: stage.turnId,
      });
      expect(outcome.kind).toBe("sent");

      const thread = await replyConversation(
        stage.agentId,
        stage.presenceId,
        "C-PROJ:777.111",
        "group",
      );
      const reply = await replyTurn(thread, "I do");
      expect(await send.buildSentContext(thread, reply.createdAt)).toContain(
        'you sent #proj-updates: "who owns the release notes?"',
      );
    });

    it("names only: a person with no name is never named by email", async () => {
      const NAMELESS = `${P}nameless`;
      await db.user.upsert({
        where: { id: NAMELESS },
        create: {
          id: NAMELESS,
          email: "nameless.asker@example.com",
          externalAuthId: NAMELESS,
          name: null,
        },
        update: {},
      });
      const stage = await askingStage("relay-nameless", NAMELESS);
      await approve(await sendToDana(stage, "are you around?"));

      const dm = await replyConversation(
        stage.agentId,
        stage.presenceId,
        "D-IM-U-DANA",
      );
      const reply = await replyTurn(dm);
      const note = await send.buildSentContext(dm, reply.createdAt);
      expect(note).toContain(
        'From another conversation, you sent Dana Guest: "are you around?"',
      );
      expect(note).not.toContain("@example.com");
    });

    it("a record older than the window is pruned on the next write", async () => {
      const stage = await askingStage("relay-prune");
      const stale = await db.channelSentMessage.create({
        data: {
          agentChannelId: stage.presenceId,
          externalThreadId: "D-IM-U-OLD",
          recipientLabel: "Old Contact",
          text: "stale",
          createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
        },
        select: { id: true },
      });
      await approve(await sendToDana(stage, "fresh one"));
      await expect
        .poll(() =>
          db.channelSentMessage.findUnique({ where: { id: stale.id } }),
        )
        .toBeNull();
    });

    it("end to end through the real doors: the recipient's DM reply is dispatched with the note, and the relay to the manager needs no card", async () => {
      const stage = await askingStage("relay-e2e");
      // The owner attached this presence: the agent's manager.
      await db.agentChannel.update({
        where: { id: stage.presenceId },
        data: { createdByUserId: OWNER },
      });
      await approve(await sendToDana(stage, "are you in the office tomorrow?"));

      // Dana answers in her DM, exactly as Slack's message.im event lands:
      // an unlinked person, admitted as a guest through the reply lane the
      // approval opened. Nothing here hand-builds the conversation.
      const reply = await ingestion.ingestDirectMessage({
        agentChannelId: stage.presenceId,
        externalUserId: "U-DANA",
        externalThreadId: "D-IM-U-DANA",
        text: "no, I'm out tomorrow",
        eventId: `${P}relay-e2e-reply`,
      });
      if (reply.kind !== "turn") throw new Error(`turn, got ${reply.kind}`);

      // The context dispatch hands the model (the runner's own composer).
      const context = await turnContext.buildTurnContext(
        stage.agentId,
        reply.conversationId,
        reply.turn.id,
        reply.turn.message,
      );
      expect(context).toContain(
        'From a conversation with Olive Owner, you sent Dana Guest: "are you in the office tomorrow?"',
      );

      // The model passes the answer back: the manager shortcut, no card.
      const relayed = await send.requestSend({
        agentId: stage.agentId,
        to: "Olive Owner",
        text: "Dana is out tomorrow.",
        originConversationId: reply.conversationId,
        originTurnId: reply.turn.id,
      });
      expect(relayed.kind).toBe("sent");
    });
  },
);
