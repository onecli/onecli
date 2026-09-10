import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../../testing/pg-proof";

/**
 * The bell's channel-arm listing (4d): pending action approvals + reach
 * asks in ONE workspace, age-merged. Pinned properties:
 *  - both kinds appear, tagged, oldest first;
 *  - settled/expired rows never appear (and legacy denied/revoked reach
 *    spellings read as settled);
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
    // Pending reach ask (newer) + a legacy-denied one (settled, hidden).
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
        externalRef: "C-DENIED",
        subjectLabel: "#denied-room",
        state: "denied",
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
    // registered handler, so it offers no always-allow (the bell row hides
    // the third button); send_message's registration does.
    expect(items[0]).toMatchObject({
      kind: "action",
      summary: 'send @Tomer: "hello"',
      agentName: "wab agent main",
      offersAlwaysAllow: false,
    });
    expect(items[1]).toMatchObject({
      kind: "reach",
      subjectKind: "space",
      subjectLabel: "#wab-room",
      externalRef: "C-WAB",
    });
    expect(items.map((i) => JSON.stringify(i)).join()).not.toContain("foreign");
    expect(items.map((i) => JSON.stringify(i)).join()).not.toContain("denied");

    // The foreign workspace sees ONLY its own.
    const foreign =
      await svc.listWorkspacePendingChannelApprovals(OTHER_WORKSPACE);
    expect(foreign).toHaveLength(1);
    expect(foreign[0]).toMatchObject({ summary: "foreign approval" });
  });
});
