import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { initEntitlementForTests } from "../lib/entitlements";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * Publishing a scope with many draft rules on REAL PostgreSQL (issue 637).
 *
 * Every policy and grant write republishes the whole draft inside one
 * interactive transaction with Prisma's default 5 s timeout. The snapshot used
 * one nested create per rule, so a workspace with a few hundred rules ran past
 * the timeout and every grant change returned 500. The snapshot is now three
 * bulk inserts.
 *
 * Laws:
 *  - a scope with 5,000 draft rules publishes inside the default timeout;
 *  - the new generation copies every rule with its priority, logicalId,
 *    conditions, identities and targets, and nothing from another scope;
 *  - an empty draft (only the Default Rule) still publishes.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Policy = typeof import("./policy-service");

let db: Db;
let policy: Policy;

const P = "pps-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const OWNER = `${P}owner`;
const GROUP = `${P}group`;

const reset = async () => {
  const orgs = { in: [ORG, OTHER_ORG] };
  await db.policyRuleV2.deleteMany({ where: { organizationId: orgs } });
  await db.group.deleteMany({ where: { organizationId: orgs } });
  await db.organizationMember.deleteMany({ where: { organizationId: orgs } });
  await db.organization.deleteMany({ where: { id: orgs } });
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
};

/** Writes `n` draft rules straight to the table, each with a group identity
 * and one network target, the shape a grant-heavy workspace has. */
const seedDrafts = async (organizationId: string, n: number) => {
  const rules = Array.from({ length: n }, (_, i) => ({
    id: randomUUID(),
    scope: "organization",
    organizationId,
    status: "draft",
    priority: i + 1,
    name: `rule ${i}`,
    action: i % 2 ? "allow" : "block",
    conditions: { note: `c${i}` },
  }));
  await db.policyRuleV2.createMany({ data: rules });
  await db.policyRuleIdentity.createMany({
    data: rules.map((r) => ({ ruleId: r.id, groupId: GROUP })),
  });
  await db.policyRuleTarget.createMany({
    data: rules.map((r, i) => ({
      ruleId: r.id,
      kind: "network",
      hostPattern: `h${i}.example.test`,
      pathPattern: "/v1/*",
      method: "GET",
    })),
  });
  return rules;
};

const published = (organizationId: string, generation: number) =>
  db.policyRuleV2.findMany({
    where: { organizationId, status: "published", generation },
    include: { identities: true, targets: true },
    orderBy: { priority: "asc" },
  });

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  policy = await import("./policy-service");
  initEntitlementForTests(true);
});

afterAll(async () => {
  initEntitlementForTests(null);
  if (!PROOF_URL) return;
  await reset();
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  const providers = await import("../providers");
  providers.initRuleActionGate({ assertAllowed: async () => {} });
  providers.initPolicyValidator({ validate: async () => {} });
  await reset();
  await db.organization.createMany({
    data: [
      { id: ORG, name: ORG, slug: ORG },
      { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
    ],
  });
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.test`,
      externalAuthId: OWNER,
      name: OWNER,
    },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: OWNER,
      userEmail: `${OWNER}@example.test`,
      role: "owner",
    },
  });
  await db.group.create({
    data: { id: GROUP, name: GROUP, organizationId: ORG },
  });
});

describe.skipIf(!PROOF_URL)("publishing a large draft", () => {
  it("publishes 5,000 rules inside the default transaction timeout and copies them whole", async () => {
    const drafts = await seedDrafts(ORG, 5000);

    const { generation, ruleCount } = await policy.publishPolicy(
      { organizationId: ORG },
      OWNER,
    );

    const rows = await published(ORG, generation);
    expect(ruleCount).toBe(rows.length);
    // The Default Rule is part of the draft too.
    const copies = rows.filter((r) => !r.isDefault);
    expect(copies).toHaveLength(drafts.length);

    const draftRows = await db.policyRuleV2.findMany({
      where: { organizationId: ORG, status: "draft", isDefault: false },
      orderBy: { priority: "asc" },
    });
    copies.forEach((r, i) => {
      const d = draftRows[i]!;
      expect(r.id).not.toBe(d.id);
      expect(r.logicalId).toBe(d.logicalId);
      expect(r.priority).toBe(d.priority);
      expect(r.name).toBe(d.name);
      expect(r.action).toBe(d.action);
      expect(r.conditions).toEqual(d.conditions);
      expect(r.createdByUserId).toBe(OWNER);
      expect(r.identities.map((x) => x.groupId)).toEqual([GROUP]);
      expect(r.targets).toHaveLength(1);
      expect(r.targets[0]).toMatchObject({
        kind: "network",
        hostPattern: `h${d.priority - 1}.example.test`,
        pathPattern: "/v1/*",
        method: "GET",
      });
    });
  }, 60_000);

  it("a second publish adds a generation and leaves another scope alone", async () => {
    await seedDrafts(ORG, 20);
    await seedDrafts(OTHER_ORG, 5);
    const first = await policy.publishPolicy({ organizationId: ORG }, OWNER);
    const second = await policy.publishPolicy({ organizationId: ORG }, OWNER);

    expect(second.generation).toBe(first.generation + 1);
    expect((await published(ORG, second.generation)).length).toBe(
      first.ruleCount,
    );
    expect(
      await db.policyRuleV2.count({
        where: { organizationId: OTHER_ORG, status: "published" },
      }),
    ).toBe(0);
  });

  it("publishes a draft that holds only the Default Rule", async () => {
    const { generation, ruleCount } = await policy.publishPolicy(
      { organizationId: ORG },
      OWNER,
    );
    const rows = await published(ORG, generation);
    expect(ruleCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isDefault).toBe(true);
  });
});
