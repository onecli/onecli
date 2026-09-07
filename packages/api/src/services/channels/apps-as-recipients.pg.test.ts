import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { proofDatabaseUrl } from "../../testing/pg-proof";

/**
 * Apps-as-recipients proofs (4e) — the Shuf fix, end to end against a real
 * DB and a fake Slack:
 *
 *  - discovery LABELS apps instead of silently filtering them (`kind: app`),
 *    while Slackbot and deleted members stay invisible;
 *  - at equal rank a person outranks an app (humans are the common intent);
 *  - an anchored app pick makes the app SENDABLE through the normal gate,
 *    and the approval summary names it as an app;
 *  - `blocked` is the standing no: the send refuses terminally AND the
 *    mention resolve degrades the name to unknown (no ping);
 *  - a legacy null-kind anchor still resolves as person (compat).
 */

const PROOF_URL = proofDatabaseUrl();

const P = "aar-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OWNER = `${P}owner`;
const TENANT = "T-AAR";

let db: typeof import("@onecli/db").db;
let search: typeof import("./recipient-search-service");
let send: typeof import("./send-message-service");
let mentions: typeof import("./mention-resolution-service");

interface SlackCall {
  method: string;
  form: URLSearchParams;
}
let slackServer: Server;
let slackCalls: SlackCall[] = [];
let slackHandlers: Record<string, (call: SlackCall) => unknown> = {};

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

/** The roster the fake answers: one human, one app bot, Slackbot, one
 * deleted member — all named "shuf"-adjacent so ranking is observable. */
const scriptRoster = () => {
  slackCalls = [];
  slackHandlers = {};
  slackHandlers["users.list"] = () => ({
    members: [
      {
        id: "U-HUMAN",
        team_id: TENANT,
        profile: { display_name: "Shuf Human" },
      },
      {
        id: "U-APPBOT",
        team_id: TENANT,
        is_bot: true,
        profile: { display_name: "Shuf" },
      },
      {
        id: "USLACKBOT",
        team_id: TENANT,
        profile: { display_name: "Slackbot" },
      },
      {
        id: "U-GONE",
        team_id: TENANT,
        deleted: true,
        profile: { display_name: "Shuf Gone" },
      },
    ],
  });
  slackHandlers["conversations.open"] = (call) => ({
    channel: { id: `D-IM-${call.form.get("users")}` },
  });
  slackHandlers["chat.postMessage"] = () => ({
    channel: "D-POSTED",
    ts: "888.111",
  });
};

let seq = 0;
let sharedIntegrationId: string | null = null;

const integrationOf = async (): Promise<string> => {
  if (sharedIntegrationId) return sharedIntegrationId;
  const integration = await db.channelIntegration.create({
    data: {
      organizationId: ORG,
      provider: "slack",
      externalId: TENANT,
      name: "AAR Workspace",
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
      name: `aar agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  const integrationId = await integrationOf();
  const { getCrypto } = await import("../../providers");
  const credentials = await getCrypto().encrypt(
    JSON.stringify({ botToken: "xoxb-aar-test" }),
  );
  seq += 1;
  const presence = await db.agentChannel.create({
    data: {
      agentId: agent.id,
      integrationId,
      provider: "slack",
      externalId: `${P}bot-${seq}`,
      identityRef: `${P}identity-${seq}`,
      transport: "socket",
      status: "active",
      credentials,
    },
    select: { id: true },
  });
  const conversation = await db.conversation.create({
    data: { agentId: agent.id, source: "slack", externalRef: `${P}${suffix}` },
    select: { id: true },
  });
  return {
    agentId: agent.id,
    integrationId,
    presenceId: presence.id,
    conversationId: conversation.id,
  };
};

const reset = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: ORG },
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
  search = await import("./recipient-search-service");
  send = await import("./send-message-service");
  mentions = await import("./mention-resolution-service");

  await reset();
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.organizationMember.deleteMany({
    where: { userId: { startsWith: P } },
  });
  await db.workspaceAccess.deleteMany({ where: { userId: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "AAR", organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.com`,
      externalAuthId: OWNER,
      name: "Ava Owner",
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  slackServer?.close();
});

describe.skipIf(!PROOF_URL)("apps as recipients (4e)", () => {
  it("labels apps instead of filtering them; Slackbot and deleted stay invisible; person outranks app on ties", async () => {
    const stage = await seedStage("label");
    scriptRoster();

    const results = await search.findPeople(stage.agentId, "shuf");
    const names = results.map((r) => `${r.name}:${r.kind}`);
    // The app IS discovered (exact match ranks first overall), the human
    // follows (prefix match), Slackbot and the deleted member never appear.
    expect(names).toContain("Shuf:app");
    expect(names).toContain("Shuf Human:person");
    expect(names.join(",")).not.toContain("Slackbot");
    expect(names.join(",")).not.toContain("Gone");
  });

  it("never discovers the agent's OWN bot user (self-invocation seed)", async () => {
    const stage = await seedStage("self");
    scriptRoster();
    const presence = await db.agentChannel.findUniqueOrThrow({
      where: { id: stage.presenceId },
      select: { identityRef: true },
    });
    slackHandlers["users.list"] = () => ({
      members: [
        {
          id: presence.identityRef,
          team_id: TENANT,
          is_bot: true,
          profile: { display_name: "Myself" },
        },
        {
          id: "U-OTHERAPP",
          team_id: TENANT,
          is_bot: true,
          profile: { display_name: "Myself Twin" },
        },
      ],
    });
    const results = await search.findPeople(stage.agentId, "myself");
    expect(results.map((r) => r.ref)).toEqual(["U-OTHERAPP"]);
  });

  it("ranks a person before an app at EQUAL rank", async () => {
    const stage = await seedStage("rank");
    scriptRoster();
    slackHandlers["users.list"] = () => ({
      members: [
        {
          id: "U-APPBOT",
          team_id: TENANT,
          is_bot: true,
          profile: { display_name: "Twin" },
        },
        {
          id: "U-HUMAN",
          team_id: TENANT,
          profile: { display_name: "Twin" },
        },
      ],
    });
    const results = await search.findPeople(stage.agentId, "twin");
    expect(results[0]).toMatchObject({ kind: "person", ref: "U-HUMAN" });
    expect(results[1]).toMatchObject({ kind: "app", ref: "U-APPBOT" });
  });

  it("a DM to an app refuses at REQUEST time with the channel-mention alternative (Slack: cannot_dm_bot)", async () => {
    const stage = await seedStage("send");
    scriptRoster();

    await search.anchorRecipient({
      conversationId: stage.conversationId,
      name: "Shuf",
      externalUserId: "U-APPBOT",
      kind: "app",
    });
    // Never held: the owner must not be asked to approve a knowable
    // failure. The refusal carries the workable alternative.
    await expect(
      send.requestSend({
        agentId: stage.agentId,
        to: "Shuf",
        text: "run the weekly report",
        originConversationId: stage.conversationId,
        originTurnId: null,
      }),
    ).rejects.toThrow(/does not allow DMs between apps/);
    expect(
      await db.actionApproval.count({ where: { agentId: stage.agentId } }),
    ).toBe(0);
  });

  it("blocked refuses the send terminally AND degrades the mention to unknown", async () => {
    const stage = await seedStage("block");
    scriptRoster();

    await search.anchorRecipient({
      conversationId: stage.conversationId,
      name: "Shuf",
      externalUserId: "U-APPBOT",
      kind: "app",
    });
    await db.agentContact.create({
      data: {
        agentId: stage.agentId,
        kind: "app",
        externalRef: "U-APPBOT",
        displayName: "Shuf",
        policy: "blocked",
        decidedByUserId: OWNER,
      },
    });

    await expect(
      send.requestSend({
        agentId: stage.agentId,
        to: "Shuf",
        text: "hi",
        originConversationId: stage.conversationId,
        originTurnId: null,
      }),
    ).rejects.toThrow(/blocked/);

    // The mention degrades too: resolve answers unknown, so the renderer
    // leaves visible plain text and pings nobody.
    const resolutions = await mentions.resolveMentionNames(
      stage.presenceId,
      ["shuf"],
      stage.conversationId,
    );
    expect(resolutions[0]).toMatchObject({ kind: "unknown", name: "shuf" });

    // And the recorded failure notice tells the TRUTH - blocked, not
    // unfindable (the guy-dev lesson: a wrong reason gets invented).
    const turn = await db.turn.create({
      data: {
        conversationId: stage.conversationId,
        message: "tag shuf",
        status: "done",
        source: "slack",
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    await db.channelThreadLink.create({
      data: {
        agentChannelId: stage.presenceId,
        conversationId: stage.conversationId,
        externalThreadId: `${P}thread-block`,
        kind: "direct",
      },
    });
    await mentions.recordMentionFailures(turn.id, [
      { kind: "unknown", name: "shuf" },
    ]);
    const notice = await db.turnEvent.findFirst({
      where: { turnId: turn.id, type: "notice" },
      select: { payload: true },
    });
    expect((notice?.payload as { text?: string })?.text).toContain(
      "the workspace owner has blocked this recipient",
    );
  });

  it("a block AFTER the hold fails the approve (TOCTOU re-check at execute)", async () => {
    const stage = await seedStage("toctou");
    scriptRoster();
    await search.anchorRecipient({
      conversationId: stage.conversationId,
      name: "Shuf Human",
      externalUserId: "U-HUMAN",
      kind: "person",
    });
    const outcome = await send.requestSend({
      agentId: stage.agentId,
      to: "Shuf Human",
      text: "held before the block",
      originConversationId: stage.conversationId,
      originTurnId: null,
    });
    expect(outcome.kind).toBe("held");
    if (outcome.kind !== "held") throw new Error("unreachable");

    // The owner blocks BETWEEN hold and approve.
    await db.agentContact.create({
      data: {
        agentId: stage.agentId,
        kind: "person",
        externalRef: "U-HUMAN",
        displayName: "Shuf Human",
        policy: "blocked",
        decidedByUserId: OWNER,
      },
    });
    await db.workspaceAccess.upsert({
      where: {
        workspaceId_userId: { workspaceId: WORKSPACE, userId: OWNER },
      },
      create: { workspaceId: WORKSPACE, userId: OWNER, role: "owner" },
      update: { role: "owner" },
    });
    const approvals = await import("./action-approval-service");
    const decided = await approvals.decideActionApproval({
      approvalId: outcome.approvalId,
      decision: "approve",
      deciderUserId: OWNER,
    });
    // Approved, but execution fails closed — nothing posted to the wire.
    expect(decided).toEqual({ kind: "decided", status: "failed" });
    const posts = slackCalls.filter((c) => c.method === "chat.postMessage");
    expect(
      posts.filter((c) => c.form.get("text")?.includes("held before")),
    ).toHaveLength(0);
    const row = await db.actionApproval.findUniqueOrThrow({
      where: { id: outcome.approvalId },
    });
    expect(row.reason).toContain("blocked");
  });

  it("always-allow never undoes an explicit block (policies only tighten)", async () => {
    const stage = await seedStage("sticky");
    await db.agentContact.create({
      data: {
        agentId: stage.agentId,
        kind: "app",
        externalRef: "U-APPBOT",
        displayName: "Shuf",
        policy: "blocked",
        decidedByUserId: OWNER,
      },
    });
    await send.allowContact({
      agentId: stage.agentId,
      recipient: { kind: "app", ref: "U-APPBOT", label: "Shuf" },
      deciderUserId: OWNER,
    });
    const row = await db.agentContact.findFirstOrThrow({
      where: { agentId: stage.agentId, externalRef: "U-APPBOT" },
    });
    expect(row.policy).toBe("blocked");
  });

  it("BODY @[Name] tokens resolve at request time, freeze into the payload, and render as real pings on delivery", async () => {
    const stage = await seedStage("body");
    scriptRoster();
    slackHandlers["conversations.list"] = () => ({
      channels: [{ id: "C-TEAM", name: "team-updates", is_member: true }],
    });

    // The app is anchored (a find_recipient pick) — the body will tag it.
    // A real-shaped id: the renderer RE-VALIDATES ids (^[UW][A-Z0-9]+$)
    // before emitting a mention, so a malformed ref can never ping.
    await search.anchorRecipient({
      conversationId: stage.conversationId,
      name: "Shuf",
      externalUserId: "UAPPBOT777",
      kind: "app",
    });
    // Channel sends deliver directly once allowed.
    await send.allowContact({
      agentId: stage.agentId,
      recipient: { kind: "channel", ref: "C-TEAM", label: "#team-updates" },
      deciderUserId: OWNER,
    });

    const before = slackCalls.filter(
      (c) => c.method === "chat.postMessage",
    ).length;
    const outcome = await send.requestSend({
      agentId: stage.agentId,
      to: "#team-updates",
      text: "@[Shuf] please run the weekly report",
      originConversationId: stage.conversationId,
      originTurnId: null,
    });
    expect(outcome.kind).toBe("sent");
    const posts = slackCalls
      .filter((c) => c.method === "chat.postMessage")
      .slice(before);
    expect(posts).toHaveLength(1);
    // The wire carries a REAL mention of the app's bot user, not plain text.
    expect(posts[0]!.form.get("text")).toContain("<@UAPPBOT777>");
    expect(posts[0]!.form.get("channel")).toBe("C-TEAM");
  });

  it("an unresolvable body token posts as plain text (no map entry, no guess)", async () => {
    const stage = await seedStage("bodyplain");
    scriptRoster();
    slackHandlers["conversations.list"] = () => ({
      channels: [{ id: "C-TEAM2", name: "team-two", is_member: true }],
    });
    await send.allowContact({
      agentId: stage.agentId,
      recipient: { kind: "channel", ref: "C-TEAM2", label: "#team-two" },
      deciderUserId: OWNER,
    });
    const before = slackCalls.filter(
      (c) => c.method === "chat.postMessage",
    ).length;
    const outcome = await send.requestSend({
      agentId: stage.agentId,
      to: "#team-two",
      text: "@[Total Stranger] hello",
      originConversationId: stage.conversationId,
      originTurnId: null,
    });
    expect(outcome.kind).toBe("sent");
    const posts = slackCalls
      .filter((c) => c.method === "chat.postMessage")
      .slice(before);
    expect(posts[0]!.form.get("text")).not.toContain("<@");
    expect(posts[0]!.form.get("text")).toContain("@Total Stranger");
  });

  it("a legacy NULL-kind anchor still resolves and sends as person (compat)", async () => {
    const stage = await seedStage("legacy");
    scriptRoster();

    // Simulate a pre-4e anchor row: kind null.
    await db.mentionAnchor.create({
      data: {
        conversationId: stage.conversationId,
        name: "old pick",
        externalUserId: "U-HUMAN",
        displayName: "Old Pick",
      },
    });
    const outcome = await send.requestSend({
      agentId: stage.agentId,
      to: "Old Pick",
      text: "still works",
      originConversationId: stage.conversationId,
      originTurnId: null,
    });
    expect(outcome.kind).toBe("held");
    if (outcome.kind !== "held") throw new Error("unreachable");
    const row = await db.actionApproval.findUniqueOrThrow({
      where: { id: outcome.approvalId },
    });
    expect(row.payload).toMatchObject({
      to: { kind: "person", ref: "U-HUMAN" },
    });
  });
});
