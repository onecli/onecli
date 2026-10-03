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
let platformTools: typeof import("../platform-tool-service");
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
  platformTools = await import("../platform-tool-service");
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
