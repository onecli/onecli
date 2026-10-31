import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * `GET /v1/channel-adapter/prompts/outcomes` over a real database and the
 * real `cha_` auth: how the approvals behind an adapter's OWN cards ended,
 * so a channel card that left the pending list says what happened ("Cancelled
 * · the agent stopped waiting") instead of guessing a decision.
 *
 * What is pinned:
 *  - a cancel, a dashboard approval and a superseded request each read as
 *    what the record says; a request with no record is absent;
 *  - fenced to the caller's slice: a card on a presence another adapter
 *    owns is never answered, and neither is a foreign tenant's approval the
 *    caller names directly (no card of its own);
 *  - the wire carries the ending and the place only: never the upstream's
 *    result, the request, or who decided;
 *  - only the `cha_` family reaches it, and a malformed query is a 422.
 */

const PROOF_URL = proofDatabaseUrl();
const P = "cpo-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}org-other`;
const WS = `${P}ws`;
const OTHER_WS = `${P}ws-other`;
const USER = `${P}user`;
const MINE = `cha_${P}mine`;
const PEER = `cha_${P}peer`;

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;

const ids = {
  cancelled: randomUUID(),
  approved: randomUUID(),
  replaced: randomUUID(),
  silent: randomUUID(),
  peerCard: randomUUID(),
  foreign: randomUUID(),
};

const read = async (token: string, approvalIds: string[]) => {
  const res = await app.request(
    `/v1/channel-adapter/prompts/outcomes?ids=${approvalIds.join(",")}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return {
    status: res.status,
    body: res.status === 200 ? ((await res.json()) as unknown) : null,
  };
};

const outcomesOf = (body: unknown) =>
  (body as { outcomes: { approvalId: string }[] }).outcomes;

const reset = async () => {
  await db.requestLog.deleteMany({
    where: { workspaceId: { in: [WS, OTHER_WS] } },
  });
  await db.channelAdapter.deleteMany({
    where: { token: { in: [MINE, PEER] } },
  });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.channelIntegration.deleteMany({
    where: { organizationId: { in: [ORG, OTHER_ORG] } },
  });
  await db.workspace.deleteMany({ where: { id: { in: [WS, OTHER_WS] } } });
  await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await db.user.deleteMany({ where: { id: USER } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  ({ db } = await import("@onecli/db"));
  const { createApiApp } = await import("../app");
  app = createApiApp({ getSession: async () => null });

  await reset();
  await db.organization.createMany({
    data: [
      { id: ORG, name: ORG, slug: ORG },
      { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
    ],
  });
  await db.workspace.createMany({
    data: [
      { id: WS, name: "Outcomes", organizationId: ORG },
      { id: OTHER_WS, name: "Foreign", organizationId: OTHER_ORG },
    ],
  });
  await db.user.create({
    data: { id: USER, email: `${USER}@example.com`, externalAuthId: USER },
  });
  const mine = await db.channelAdapter.create({
    data: { token: MINE, name: `${P}mine`, kind: "instance" },
  });
  const peer = await db.channelAdapter.create({
    data: { token: PEER, name: `${P}peer`, kind: "instance" },
  });

  const agent = async (workspaceId: string, name: string) =>
    (
      await db.agent.create({
        data: {
          workspaceId,
          name,
          identifier: `${P}${name}`,
          accessToken: `aoc_${P}${name}`,
          kind: "hosted",
          harness: "fake",
        },
        select: { id: true },
      })
    ).id;
  const ada = await agent(WS, "ada");
  const rafi = await agent(WS, "rafi");
  const stranger = await agent(OTHER_WS, "stranger");

  const integration = await db.channelIntegration.create({
    data: {
      organizationId: ORG,
      provider: "slack",
      externalId: `${P}team`,
      name: "Outcomes",
      createdByUserId: USER,
    },
    select: { id: true },
  });
  const presence = async (
    agentId: string,
    appId: string,
    ownerAdapterId: string,
  ) =>
    (
      await db.agentChannel.create({
        data: {
          agentId,
          integrationId: integration.id,
          provider: "slack",
          externalId: appId,
          transport: "socket",
          ownerAdapterId,
          createdByUserId: USER,
        },
        select: { id: true },
      })
    ).id;
  const adaPresence = await presence(ada, `${P}A1`, mine.id);
  // Same organization, same provider: only the owning adapter differs.
  const rafiPresence = await presence(rafi, `${P}A2`, peer.id);

  const card = (approvalId: string, agentChannelId: string) =>
    db.toolApprovalCard.create({
      data: { approvalId, agentChannelId, externalThreadId: "D100" },
    });
  for (const id of [ids.cancelled, ids.approved, ids.replaced, ids.silent]) {
    await card(id, adaPresence);
  }
  await card(ids.peerCard, rafiPresence);

  const gatewayRow = (
    workspaceId: string,
    agentId: string,
    approvalId: string,
    extra: Record<string, unknown>,
  ) =>
    db.requestLog.create({
      data: {
        workspaceId,
        agentId,
        method: "POST",
        host: "api.heyreach.io",
        path: "/api/public/inbox/SendMessage",
        provider: "heyreach",
        status: 200,
        latencyMs: 5,
        injectionCount: 1,
        extraData: { approval_id: approvalId, ...extra },
      },
    });
  await gatewayRow(WS, ada, ids.cancelled, {
    decision: "approval_cancelled",
  });
  await gatewayRow(WS, ada, ids.approved, {
    decision: "approval_approved",
    approval_result: { ok: false, error: "secret upstream detail" },
  });
  await gatewayRow(WS, ada, ids.replaced, {
    decision: "approval_denied",
    approval_reason: "superseded",
  });
  await gatewayRow(WS, rafi, ids.peerCard, {
    decision: "approval_cancelled",
  });
  await gatewayRow(OTHER_WS, stranger, ids.foreign, {
    decision: "approval_approved",
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
});

describe.skipIf(!PROOF_URL)("adapter card outcomes (pg)", () => {
  it("reads each ending from the record, and leaves a silent one out", async () => {
    const { status, body } = await read(MINE, [
      ids.cancelled,
      ids.approved,
      ids.replaced,
      ids.silent,
    ]);
    expect(status).toBe(200);
    const byId = new Map(outcomesOf(body).map((o) => [o.approvalId, o]));
    expect(byId.get(ids.cancelled)).toEqual({
      approvalId: ids.cancelled,
      outcome: "cancelled",
    });
    expect(byId.get(ids.approved)).toEqual({
      approvalId: ids.approved,
      outcome: "approved",
    });
    expect(byId.get(ids.replaced)).toEqual({
      approvalId: ids.replaced,
      outcome: "replaced",
    });
    expect(byId.has(ids.silent)).toBe(false);
  });

  it("never carries the upstream's answer or the request onto the wire", async () => {
    const { body } = await read(MINE, [ids.approved]);
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("secret upstream detail");
    expect(wire).not.toContain("decidedAt");
    expect(wire).not.toContain("SendMessage");
  });

  it("never answers for a card another adapter owns, even in the same organization", async () => {
    const { status, body } = await read(MINE, [ids.peerCard]);
    expect(status).toBe(200);
    expect(outcomesOf(body)).toEqual([]);
    // The owner reads its own card.
    const own = await read(PEER, [ids.peerCard]);
    expect(outcomesOf(own.body)).toEqual([
      { approvalId: ids.peerCard, outcome: "cancelled" },
    ]);
  });

  it("never answers for another tenant's approval named directly", async () => {
    const { status, body } = await read(MINE, [ids.foreign]);
    expect(status).toBe(200);
    expect(outcomesOf(body)).toEqual([]);
  });

  it("refuses every other credential, and a malformed query", async () => {
    const res = await app.request(
      `/v1/channel-adapter/prompts/outcomes?ids=${ids.cancelled}`,
      { headers: { authorization: `Bearer oc_${P}not-an-adapter` } },
    );
    expect(res.status).toBe(401);
    expect((await read(MINE, ["not-a-uuid"])).status).toBe(422);
  });
});
