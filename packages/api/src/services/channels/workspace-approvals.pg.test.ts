import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../../testing/pg-proof";
import { CUSTOM_CONNECTION_ACTION } from "../../validations/custom-connection";

/**
 * The bell's channel-arm listing (4d): pending action approvals + reach
 * asks in ONE workspace, age-merged. Pinned properties:
 *  - both kinds appear, tagged, oldest first;
 *  - settled/expired rows never appear (a blocked reach row stays off the
 *    bell);
 *  - the workspace fence: a FOREIGN workspace's rows are invisible (the
 *    planted negative control).
 */

const PROOF_URL = proofDatabaseUrl();

const P = "wab-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OTHER_WORKSPACE = `${P}other-ws`;
const OWNER = `${P}owner`;

let db: typeof import("@onecli/db").db;
let svc: typeof import("./workspace-approvals-service");

const seedAgent = async (suffix: string, workspaceId = WORKSPACE) => {
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `wab agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
    },
    select: { id: true },
  });
  return agent.id;
};

const reset = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  ({ db } = await import("@onecli/db"));
  svc = await import("./workspace-approvals-service");

  await reset();
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.organizationMember.deleteMany({
    where: { userId: { startsWith: P } },
  });
  await db.workspaceAccess.deleteMany({ where: { userId: { startsWith: P } } });
  await db.workspace.deleteMany({
    where: { id: { in: [WORKSPACE, OTHER_WORKSPACE] } },
  });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.createMany({
    data: [
      { id: WORKSPACE, name: "WAB", organizationId: ORG },
      { id: OTHER_WORKSPACE, name: "WAB Other", organizationId: ORG },
    ],
  });
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.com`,
      externalAuthId: OWNER,
      name: "Wanda Owner",
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
});

describe.skipIf(!PROOF_URL)("workspace pending channel approvals (4d)", () => {
  it("merges both kinds oldest-first, hides settled/expired, fences the workspace", async () => {
    const agentId = await seedAgent("main");
    const foreignAgentId = await seedAgent("foreign", OTHER_WORKSPACE);
    const integration = await db.channelIntegration.create({
      data: {
        organizationId: ORG,
        provider: "slack",
        externalId: "T-WAB",
        name: "WAB Workspace",
        createdByUserId: OWNER,
      },
      select: { id: true },
    });

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const dayAhead = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Pending action approval (older) + one EXPIRED (never listed).
    await db.actionApproval.create({
      data: {
        agentId,
        action: "test.wab",
        payload: {},
        summary: 'send @Tomer: "hello"',
        status: "pending",
        createdAt: hourAgo,
        expiresAt: dayAhead,
        cardRefs: [],
      },
    });
    await db.actionApproval.create({
      data: {
        agentId,
        action: "test.wab",
        payload: {},
        summary: "expired one",
        status: "pending",
        expiresAt: new Date(Date.now() - 1000),
        cardRefs: [],
      },
    });
    // Pending reach ask (newer) + a blocked one (settled, hidden).
    await db.agentReachGrant.create({
      data: {
        agentId,
        integrationId: integration.id,
        provider: "slack",
        subjectKind: "space",
        externalRef: "C-WAB",
        subjectLabel: "#wab-room",
        state: "pending",
        cardRefs: [],
      },
    });
    await db.agentReachGrant.create({
      data: {
        agentId,
        integrationId: integration.id,
        provider: "slack",
        subjectKind: "space",
        externalRef: "C-BLOCKED",
        subjectLabel: "#blocked-room",
        state: "blocked",
        cardRefs: [],
      },
    });
    // The planted negative control: a FOREIGN workspace's pending rows.
    await db.actionApproval.create({
      data: {
        agentId: foreignAgentId,
        action: "test.wab",
        payload: {},
        summary: "foreign approval",
        status: "pending",
        expiresAt: dayAhead,
        cardRefs: [],
      },
    });

    const items = await svc.listWorkspacePendingChannelApprovals(WORKSPACE);
    expect(items).toHaveLength(2);
    // Oldest first: the hour-old action approval leads. `test.wab` has no
    // registered handler, so it asks no standing question (the bell row
    // reads Approve / Reject); send_message's registration does.
    expect(items[0]).toMatchObject({
      kind: "action",
      summary: 'send @Tomer: "hello"',
      agentName: "wab agent main",
      standingChoice: false,
      // No asking conversation on this hold: every member's chat with the
      // agent shows it, besides the bell.
      conversationId: null,
    });
    expect(items[1]).toMatchObject({
      kind: "reach",
      subjectKind: "space",
      subjectLabel: "#wab-room",
      externalRef: "C-WAB",
    });
    expect(items.map((i) => JSON.stringify(i)).join()).not.toContain("foreign");
    expect(items.map((i) => JSON.stringify(i)).join()).not.toContain(
      "blocked-room",
    );

    // The foreign workspace sees ONLY its own.
    const foreign =
      await svc.listWorkspacePendingChannelApprovals(OTHER_WORKSPACE);
    expect(foreign).toHaveLength(1);
    expect(foreign[0]).toMatchObject({ summary: "foreign approval" });
  });

  it("hands the custom-connection card only the name and where the key goes", async () => {
    const agentId = await seedAgent("custom");
    await db.actionApproval.create({
      data: {
        agentId,
        action: CUSTOM_CONNECTION_ACTION,
        payload: {
          name: "AcmeCRM",
          hostPattern: "api.acmecrm.io",
          pathPattern: "/v1/*",
          headerName: "X-Api-Key",
          valueFormat: "{value}",
          docsUrl: "https://docs.acmecrm.io/auth",
          reason: "You asked for your AcmeCRM campaigns.",
        },
        summary: 'connect "AcmeCRM"',
        status: "pending",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        cardRefs: [],
      },
    });

    const items = await svc.listWorkspacePendingChannelApprovals(WORKSPACE);
    const custom = items.find(
      (i) => i.kind === "action" && i.customConnection !== null,
    );
    // Exactly these three: the agent's docs link and reason never reach the
    // browser, so the card cannot render (or link) anything else it wrote.
    expect(custom?.kind === "action" && custom.customConnection).toEqual({
      name: "AcmeCRM",
      hostPattern: "api.acmecrm.io",
      registrableDomain: "acmecrm.io",
    });
  });

  it("a scheduled run's approval shows in the chat the schedule reports to", async () => {
    await reset();
    const agentId = await seedAgent("cron");
    const dayAhead = new Date(Date.now() + 24 * 60 * 60 * 1000);
    // The person's chat, where they asked for the schedule.
    const chat = await db.conversation.create({
      data: { agentId, direct: true, source: "web", userId: OWNER },
      select: { id: true },
    });
    const cron = await db.agentCron.create({
      data: {
        agentId,
        name: "morning digest",
        prompt: "summarize my inbox",
        schedule: "0 9 * * *",
        timezone: "UTC",
        originConversationId: chat.id,
        createdByUserId: OWNER,
        nextFireAt: dayAhead,
      },
      select: { id: true },
    });
    // The schedule's own run conversation, which no chat renders.
    const run = await db.conversation.create({
      data: { agentId, source: "cron", externalRef: cron.id },
      select: { id: true },
    });
    // A schedule created with no chat (origin lost): stays on its run.
    const orphanCron = await db.agentCron.create({
      data: {
        agentId,
        name: "no origin",
        prompt: "p",
        schedule: "0 9 * * *",
        timezone: "UTC",
        nextFireAt: dayAhead,
      },
      select: { id: true },
    });
    const orphanRun = await db.conversation.create({
      data: { agentId, source: "cron", externalRef: orphanCron.id },
      select: { id: true },
    });
    // A webhook's run reports to the chat it was created from, too.
    const webhook = await db.agentWebhook.create({
      data: {
        agentId,
        name: "deploys",
        instructions: "tell me when a deploy fails",
        token: `whk_${P}token`,
        originConversationId: chat.id,
      },
      select: { id: true },
    });
    const webhookRun = await db.conversation.create({
      data: { agentId, source: "webhook", externalRef: webhook.id },
      select: { id: true },
    });
    for (const [summary, conversationId] of [
      ["from the run", run.id],
      ["from the chat", chat.id],
      ["from an orphan run", orphanRun.id],
      ["from a webhook run", webhookRun.id],
    ] as const) {
      await seedHold(agentId, summary, conversationId);
    }

    expect(await placements()).toEqual({
      "from the run": chat.id,
      "from the chat": chat.id,
      "from an orphan run": orphanRun.id,
      "from a webhook run": chat.id,
    });
  });

  it("never re-points a hold into another agent's chat", async () => {
    await reset();
    const agentId = await seedAgent("victim");
    const otherAgentId = await seedAgent("forger");
    const dayAhead = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const victimChat = await db.conversation.create({
      data: { agentId, direct: true, source: "web", userId: OWNER },
      select: { id: true },
    });
    const cron = await db.agentCron.create({
      data: {
        agentId,
        name: "victim schedule",
        prompt: "p",
        schedule: "0 9 * * *",
        timezone: "UTC",
        originConversationId: victimChat.id,
        nextFireAt: dayAhead,
      },
      select: { id: true },
    });
    // Any member can mint a conversation with any source and ref: here one
    // on ANOTHER agent that claims to be the victim schedule's run.
    const forged = await db.conversation.create({
      data: { agentId: otherAgentId, source: "cron", externalRef: cron.id },
      select: { id: true },
    });
    await seedHold(otherAgentId, "forged run", forged.id);

    expect(await placements()).toEqual({ "forged run": forged.id });
  });
});

const seedHold = (agentId: string, summary: string, conversationId: string) =>
  db.actionApproval.create({
    data: {
      agentId,
      conversationId,
      action: "test.wab",
      payload: {},
      summary,
      status: "pending",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      cardRefs: [],
    },
  });

/** Each listed action's summary → the conversation its card renders in. */
const placements = async () =>
  Object.fromEntries(
    (await svc.listWorkspacePendingChannelApprovals(WORKSPACE)).flatMap((i) =>
      i.kind === "action" ? [[i.summary, i.conversationId]] : [],
    ),
  );
