import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * APPROVAL OUTCOMES on REAL PostgreSQL (the JSON-path audit query is the
 * point). Laws:
 *  - a Slack click reads "approved via slack" with the row's time; a web
 *    click reads `via: web`; the decider's identity never leaves the API;
 *  - a superseded deny reads "replaced";
 *  - the first decision wins (a later "already settled" row changes nothing);
 *  - only recent records are read (the indexed window);
 *  - fenced: another workspace's agent is NOT_FOUND, and an approval the
 *    caller's agent did not raise is never answered, even in its workspace.
 */

const PROOF_URL = proofDatabaseUrl();
const P = "aos-";
const ORG = `${P}org`;
const WS = `${P}ws`;
const OTHER_WS = `${P}ws-other`;
const USER = `${P}user`;

type Db = typeof import("@onecli/db").db;
type Svc = typeof import("./approval-outcome-service");
let db: Db;
let svc: Svc;
let agentId = "";
let siblingAgentId = "";
let foreignAgentId = "";
let presenceId = "";

const ids = {
  slack: randomUUID(),
  web: randomUUID(),
  replaced: randomUUID(),
  sibling: randomUUID(),
  dashboard: randomUUID(),
  expired: randomUUID(),
  siblingRow: randomUUID(),
  stale: randomUUID(),
};

/** Times relative to now: the read only looks back a day. */
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();
const T = {
  slack: ago(30),
  slackLater: ago(29),
  web: ago(28),
  replaced: ago(27),
  sibling: ago(26),
  dashboard: ago(25),
  stale: ago(3 * 24 * 60),
};

const reset = async () => {
  await db.auditLog.deleteMany({ where: { userId: USER } });
  await db.requestLog.deleteMany({ where: { workspaceId: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: USER } });
};

const audit = (
  action: "approve" | "deny",
  metadata: Record<string, string>,
  createdAt: string,
) =>
  db.auditLog.create({
    data: {
      workspaceId: WS,
      userId: USER,
      userEmail: `${USER}@example.com`,
      action,
      service: "channel",
      status: "success",
      source: "api",
      metadata,
      createdAt: new Date(createdAt),
    },
  });

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  svc = await import("./approval-outcome-service");
  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.createMany({
    data: [
      { id: WS, name: "Outcomes", organizationId: ORG },
      { id: OTHER_WS, name: "Other", organizationId: ORG },
    ],
  });
  await db.user.create({
    data: {
      id: USER,
      name: "Alex Kim",
      email: `${USER}@example.com`,
      externalAuthId: USER,
    },
  });
  const mk = async (ws: string, suffix: string) =>
    (
      await db.agent.create({
        data: {
          workspaceId: ws,
          name: suffix,
          identifier: `${P}${suffix}`,
          accessToken: `aoc_${P}${suffix}`,
          kind: "hosted",
          harness: "fake",
        },
        select: { id: true },
      })
    ).id;
  agentId = await mk(WS, "ada");
  siblingAgentId = await mk(WS, "rafi");
  foreignAgentId = await mk(OTHER_WS, "stranger");
  const integration = await db.channelIntegration.create({
    data: {
      organizationId: ORG,
      provider: "slack",
      externalId: `${P}team`,
      name: "Outcomes",
      createdByUserId: USER,
    },
  });
  presenceId = (
    await db.agentChannel.create({
      data: {
        agentId,
        integrationId: integration.id,
        provider: "slack",
        externalId: `${P}app`,
        transport: "socket",
      },
    })
  ).id;

  await audit(
    "approve",
    { approvalId: ids.slack, agentId, presenceId, decision: "approve" },
    T.slack,
  );
  // A later "already settled" click on the same card: never the answer.
  await audit(
    "deny",
    { approvalId: ids.slack, agentId, presenceId, decision: "deny" },
    T.slackLater,
  );
  await audit(
    "deny",
    { approvalId: ids.web, agentId, decision: "deny" },
    T.web,
  );
  await audit(
    "deny",
    { approvalId: ids.replaced, agentId, reason: "superseded" },
    T.replaced,
  );
  await audit(
    "approve",
    { approvalId: ids.sibling, agentId: siblingAgentId, decision: "approve" },
    T.sibling,
  );
  // Outside the read's window: an old decision is never scanned.
  await audit(
    "approve",
    { approvalId: ids.stale, agentId, presenceId, decision: "approve" },
    T.stale,
  );
  // The gateway's rows: the Slack-approved one carries what Salesforce
  // answered; a dashboard approval has no audit row at all.
  const gatewayRow = (
    agent: string,
    approvalId: string,
    extra: Record<string, unknown>,
    createdAt = new Date(),
  ) =>
    db.requestLog.create({
      data: {
        workspaceId: WS,
        agentId: agent,
        method: "POST",
        host: "acme.my.salesforce.com",
        path: "/services/data/v62.0/composite/sobjects",
        provider: "salesforce",
        status: 200,
        latencyMs: 5,
        injectionCount: 1,
        extraData: { approval_id: approvalId, ...extra },
        createdAt,
      },
    });
  await gatewayRow(agentId, ids.slack, {
    decision: "approval_approved",
    resolved_at: T.slack,
    approval_result: {
      ok: false,
      succeeded: 0,
      total: 9,
      error: "BillingCountry: There's a problem with this country",
    },
  });
  await gatewayRow(agentId, ids.dashboard, {
    decision: "approval_approved",
    resolved_at: T.dashboard,
    approval_result: { ok: true },
  });
  await gatewayRow(agentId, ids.expired, {
    decision: "approval_denied",
    approval_reason: "timed out",
  });
  await gatewayRow(siblingAgentId, ids.siblingRow, {
    decision: "approval_approved",
    approval_result: { ok: false, error: "secret sibling result" },
  });
  await gatewayRow(
    agentId,
    ids.stale,
    { decision: "approval_approved", approval_result: { ok: true } },
    new Date(T.stale),
  );
});

afterAll(async () => {
  if (PROOF_URL) await reset();
});

describe.skipIf(!PROOF_URL)("approval outcomes (pg)", () => {
  const read = (agent: string, approvalIds: string[]) =>
    svc.listApprovalOutcomes({
      workspaceId: WS,
      organizationId: ORG,
      agentId: agent,
      approvalIds,
    });

  it("names where and when each approval was decided, never who", async () => {
    const out = await read(agentId, [ids.slack, ids.web, ids.replaced]);
    const by = new Map(out.map((o) => [o.approvalId, o]));
    expect(by.get(ids.slack)).toEqual({
      approvalId: ids.slack,
      outcome: "approved",
      via: "slack",
      decidedAt: T.slack,
      result: {
        ok: false,
        succeeded: 0,
        total: 9,
        error: "BillingCountry: There's a problem with this country",
      },
    });
    expect(by.get(ids.web)).toMatchObject({ outcome: "denied", via: "web" });
    expect(by.get(ids.replaced)).toMatchObject({ outcome: "replaced" });
  });

  it("answers a dashboard approval from the gateway's row alone", async () => {
    const [out] = await read(agentId, [ids.dashboard]);
    expect(out).toMatchObject({
      outcome: "approved",
      decidedAt: T.dashboard,
      result: { ok: true },
    });
    expect(out?.via).toBeUndefined();
  });

  it("reads only the recent window: an old decision is not answered", async () => {
    expect(await read(agentId, [ids.stale])).toEqual([]);
  });

  it("leaves an expiry to the browser (no outcome)", async () => {
    expect(await read(agentId, [ids.expired])).toEqual([]);
  });

  it("never answers for another agent's approval, even in the same workspace", async () => {
    expect(await read(agentId, [ids.sibling, ids.siblingRow])).toEqual([]);
  });

  it("refuses an agent outside the caller's workspace", async () => {
    await expect(read(foreignAgentId, [ids.slack])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
