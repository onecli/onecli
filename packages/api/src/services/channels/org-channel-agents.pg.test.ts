import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../../testing/pg-proof";

/**
 * The org Channels page's one-click list: every hosted agent in the org,
 * grouped by workspace, with where it stands in Slack. The fence is the org:
 * a foreign org's workspace and agent are planted and must never appear.
 */

const PROOF_URL = proofDatabaseUrl();
const P = "oca-";
const ORG = `${P}org`;
const FOREIGN_ORG = `${P}foreign-org`;
const OWNER = `${P}owner`;

let db: typeof import("@onecli/db").db;
let service: typeof import("./channel-integration-service");

const reset = async () => {
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: { in: [ORG, FOREIGN_ORG] } },
  });
  await db.workspace.deleteMany({
    where: { organizationId: { in: [ORG, FOREIGN_ORG] } },
  });
  await db.organization.deleteMany({
    where: { id: { in: [ORG, FOREIGN_ORG] } },
  });
  await db.user.deleteMany({ where: { id: OWNER } });
};

/** Distinct, increasing `createdAt`s. The list is in creation order, and
 * `created_at` is millisecond-precision: fixtures inserted back to back can
 * share a millisecond and then come back in either order. */
let createdAt = Date.now() - 60_000;
const nextCreatedAt = () => new Date((createdAt += 1000));

const agent = (
  workspaceId: string,
  name: string,
  kind: "hosted" | "byo" = "hosted",
) =>
  db.agent.create({
    data: {
      workspaceId,
      name,
      identifier: `${P}${name.toLowerCase().replace(/\W/g, "")}`,
      accessToken: `aoc_${P}${name.toLowerCase().replace(/\W/g, "")}`,
      kind,
      ...(kind === "hosted" ? { harness: "fake" } : {}),
      createdAt: nextCreatedAt(),
    },
    select: { id: true },
  });

const presence = (
  agentId: string,
  integrationId: string,
  status: string,
  n: number,
  transport: "events" | "socket" = "events",
) =>
  db.agentChannel.create({
    data: {
      agentId,
      integrationId,
      provider: "slack",
      externalId: `${P}app-${n}`,
      identityName: `bot-${n}`,
      transport,
      status,
    },
  });

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  ({ db } = await import("@onecli/db"));
  service = await import("./channel-integration-service");
  await reset();
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
});

describe.skipIf(!PROOF_URL)("listOrgChannelAgents", () => {
  it("lists the org's hosted agents by workspace with their Slack state - and nothing from another org", async () => {
    await db.organization.createMany({
      data: [
        { id: ORG, name: ORG, slug: ORG },
        { id: FOREIGN_ORG, name: FOREIGN_ORG, slug: FOREIGN_ORG },
      ],
    });
    await db.user.create({
      data: {
        id: OWNER,
        email: `${OWNER}@example.com`,
        externalAuthId: OWNER,
      },
    });
    const sales = await db.workspace.create({
      data: {
        name: "Sales",
        slug: `${P}sales`,
        organizationId: ORG,
        createdAt: nextCreatedAt(),
      },
      select: { id: true },
    });
    const ops = await db.workspace.create({
      data: {
        name: "Ops",
        slug: `${P}ops`,
        organizationId: ORG,
        createdAt: nextCreatedAt(),
      },
      select: { id: true },
    });
    const foreign = await db.workspace.create({
      data: {
        name: "Foreign",
        slug: `${P}foreign`,
        organizationId: FOREIGN_ORG,
      },
      select: { id: true },
    });
    const integration = await db.channelIntegration.create({
      data: {
        organizationId: ORG,
        provider: "slack",
        externalId: "T-OCA",
        createdByUserId: OWNER,
      },
      select: { id: true },
    });
    const foreignIntegration = await db.channelIntegration.create({
      data: {
        organizationId: FOREIGN_ORG,
        provider: "slack",
        externalId: "T-OCA-FOREIGN",
        createdByUserId: OWNER,
      },
      select: { id: true },
    });

    const fresh = await agent(sales.id, "Fresh");
    const stuck = await agent(sales.id, "Stuck");
    const live = await agent(ops.id, "Live");
    const broken = await agent(ops.id, "Broken");
    const pasting = await agent(ops.id, "Pasting");
    await agent(ops.id, "Byo", "byo");
    const intruder = await agent(foreign.id, "Intruder");
    await presence(stuck.id, integration.id, "pending_setup", 1);
    await presence(live.id, integration.id, "active", 2);
    await presence(broken.id, integration.id, "needs_attention", 3);
    await presence(intruder.id, foreignIntegration.id, "active", 4);
    // A socket app's install finishes by pasting tokens, not by a click.
    await presence(pasting.id, integration.id, "pending_setup", 5, "socket");

    const view = await service.listOrgChannelAgents({
      organizationId: ORG,
      provider: "slack",
    });

    // The test process has no https self-url, so a fresh add is socket.
    expect(view.posture).toEqual({ transport: "socket" });
    expect(view.workspaces).toEqual([
      {
        id: sales.id,
        name: "Sales",
        agents: [
          {
            id: fresh.id,
            name: "Fresh",
            imageUrl: null,
            state: "none",
            pendingTransport: null,
            slack: null,
          },
          // Pending: not installed, so nothing to open or mention yet.
          {
            id: stuck.id,
            name: "Stuck",
            imageUrl: null,
            state: "pending",
            pendingTransport: "events",
            slack: null,
          },
        ],
      },
      {
        id: ops.id,
        name: "Ops",
        // The BYO agent cannot join channels, so it is not offered.
        agents: [
          {
            id: live.id,
            name: "Live",
            imageUrl: null,
            state: "active",
            pendingTransport: null,
            slack: { appId: `${P}app-2`, teamId: "T-OCA", handle: "bot-2" },
          },
          {
            id: broken.id,
            name: "Broken",
            imageUrl: null,
            state: "attention",
            pendingTransport: null,
            slack: null,
          },
          {
            id: pasting.id,
            name: "Pasting",
            imageUrl: null,
            state: "pending",
            pendingTransport: "socket",
            slack: null,
          },
        ],
      },
    ]);
    // The planted foreign workspace and agent never appear.
    expect(JSON.stringify(view)).not.toContain(intruder.id);
    expect(JSON.stringify(view)).not.toContain(foreign.id);
  });
});
