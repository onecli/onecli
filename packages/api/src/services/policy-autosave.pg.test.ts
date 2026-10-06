import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * Org policy writes are enforced immediately, on REAL PostgreSQL. There is no
 * staged draft and no Apply step: every write (create, update, delete,
 * reorder, Default Rule) publishes the scope's draft in its own transaction,
 * so the live generation always equals the draft the console shows.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Policy = typeof import("./policy-service");

let db: Db;
let policy: Policy;

const ORG = "pas-org";
const OWNER = "pas-owner";
const SCOPE = { organizationId: ORG };

const reset = async () => {
  await db.policyRuleV2.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: OWNER } });
};

/** The live (published) set, in evaluation order, as comparable tuples. */
const live = async () =>
  (await policy.listPolicyRules(SCOPE, "published")).map(
    (r) => `${r.logicalId}:${r.name}:${r.action}:${r.enabled}`,
  );
const draft = async () =>
  (await policy.listPolicyRules(SCOPE, "draft")).map(
    (r) => `${r.logicalId}:${r.name}:${r.action}:${r.enabled}`,
  );

const create = (name: string, host: string) =>
  policy.createPolicyRule(
    SCOPE,
    {
      name,
      action: "block",
      targets: [{ kind: "network", hostPattern: host }],
    },
    OWNER,
  );

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  policy = await import("./policy-service");
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  const providers = await import("../providers");
  providers.initRuleActionGate({ assertAllowed: async () => {} });
  providers.initPolicyValidator({ validate: async () => {} });
  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.test`,
      externalAuthId: OWNER,
      name: OWNER,
    },
  });
});

describe.skipIf(!PROOF_URL)("org policy writes apply immediately", () => {
  it("create, update, reorder and delete each leave live == draft", async () => {
    const a = await create("a", "a.example.test");
    expect(await live()).toEqual(await draft());
    expect(await live()).toHaveLength(1);

    const b = await create("b", "b.example.test");
    expect(await live()).toEqual(await draft());

    await policy.updatePolicyRule(SCOPE, a.id, { enabled: false }, OWNER);
    expect(await live()).toEqual(await draft());
    expect(await live()).toContain(`${a.logicalId}:a:block:false`);

    await policy.reorderPolicyRules(SCOPE, [b.id, a.id], OWNER);
    expect(await live()).toEqual(await draft());
    expect((await live())[0]).toContain(b.logicalId);

    await policy.deletePolicyRule(SCOPE, a.id, OWNER);
    expect(await live()).toEqual(await draft());
    expect(await live()).toHaveLength(1);
  });

  it("the Default Rule flip is live at once", async () => {
    await policy.setPolicyDefaultAction(SCOPE, "block", OWNER);
    expect(await policy.getPolicyDefault(SCOPE, "published")).toMatchObject({
      action: "block",
    });
  });

  it("records who made the change on the live generation", async () => {
    await create("a", "a.example.test");
    expect(await policy.getLastPublish(SCOPE)).toMatchObject({
      appliedBy: { email: `${OWNER}@example.test` },
    });
  });
});
