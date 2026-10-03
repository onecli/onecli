import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { initEntitlementForTests } from "../lib/entitlements";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * Deleting a USER or a GROUP on REAL PostgreSQL: the rules that named only
 * that principal go with it, so they never outlive it as identity-less
 * ("applies to everyone") rules. The agent half is
 * workspace-autoattach-service.pg.test.ts (#1167).
 *
 * Decisions are read through the reflections' path (published org rules →
 * toSimRule → evaluateNew), the TS mirror of the gateway's engine. The bug,
 * before this fix:
 *  - a deleted group's "only G may reach X" allow opened X to every user,
 *    past the org's deny default;
 *  - a deleted user's "block U from Y" blocked every user from Y.
 *
 * Laws, each driven through the real deletion path:
 *  - a rule naming ONLY the principal goes, in the draft and every retained
 *    published generation (no rollback brings it back);
 *  - a rule naming other principals too keeps them, minus this one;
 *  - an authored "everyone" rule and another org's rules are untouched;
 *  - nothing is published (a staged draft edit stays staged);
 *  - a user's rules in EVERY org they were named in go, and those orgs are
 *    returned for the gateway flush;
 *  - a group delete never deadlocks against concurrent rule writes.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Policy = typeof import("./policy-service");

let db: Db;
let policy: Policy;

const P = "ppd-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WORKSPACE = `${P}ws`;
const OWNER = `${P}owner`;
const LEAVER = `${P}leaver`;
const BYSTANDER = `${P}bystander`;
const GROUP = `${P}group`;
const OTHER_GROUP = `${P}other-group`;
const FOREIGN_GROUP = `${P}foreign-group`;

const ORG_SCOPE = { organizationId: ORG };

const reset = async () => {
  const orgs = { in: [ORG, OTHER_ORG] };
  await db.policyRuleV2.deleteMany({ where: { organizationId: orgs } });
  await db.groupMember.deleteMany({
    where: { group: { organizationId: orgs } },
  });
  await db.group.deleteMany({ where: { organizationId: orgs } });
  await db.organizationMember.deleteMany({ where: { organizationId: orgs } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: orgs } });
  await db.auditLog.deleteMany({ where: { userId: { startsWith: P } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
};

const makeUser = async (id: string, orgs: string[] = [ORG]) => {
  await db.user.create({
    data: { id, email: `${id}@example.test`, externalAuthId: id, name: id },
  });
  for (const organizationId of orgs) {
    await db.organizationMember.create({
      data: {
        organizationId,
        userId: id,
        userEmail: `${id}@example.test`,
        role: id === OWNER ? "owner" : "member",
      },
    });
  }
};

const makeGroup = (id: string, organizationId = ORG) =>
  db.group.create({ data: { id, name: id, organizationId } });

type Identity = { type: "user" | "group"; id: string };

const rule = (
  scope: { organizationId: string },
  name: string,
  action: "allow" | "block",
  host: string,
  identities: Identity[] = [],
) =>
  policy.createPolicyRule(
    scope,
    {
      name,
      action,
      identities,
      targets: [{ kind: "network", hostPattern: host }],
    },
    OWNER,
  );

const publish = (organizationId = ORG) =>
  policy.publishPolicy({ organizationId }, OWNER);

/** The org's decision for a request by `userIds` / `groupIds`. */
const decide = async (
  host: string,
  principals: { userIds?: string[]; groupIds?: string[] },
) => {
  const [loaders, simRule, hosts, providers, evaluator] = await Promise.all([
    import("./policy-simulate/load-rules"),
    import("./policy-simulate/sim-rule"),
    import("./policy-simulate/secret-hosts"),
    import("./policy-simulate/connection-providers"),
    import("./policy-translation/evaluator"),
  ]);
  const [rows, secretHosts, connectionProviders] = await Promise.all([
    loaders.loadRulesForSimulation(
      { scope: "organization", organizationId: ORG },
      "published",
    ),
    hosts.loadSecretHosts(ORG, WORKSPACE),
    providers.loadConnectionProviders(ORG, WORKSPACE),
  ]);
  return evaluator.evaluateNew(
    rows.map(
      (r) => simRule.toSimRule(r, secretHosts, connectionProviders).rule,
    ),
    {
      host,
      path: "/",
      method: "GET",
      agentId: `${P}agent`,
      userIds: principals.userIds ?? [],
      groupIds: principals.groupIds ?? [],
      hasInjections: true,
      isLlmHost: false,
    },
  );
};

/** Rules (any status / generation) still in `organizationId` with NO identity:
 * exactly what the bug leaves behind. */
const everyoneRules = (organizationId = ORG) =>
  db.policyRuleV2.findMany({
    where: { organizationId, isDefault: false, identities: { none: {} } },
    select: { name: true, status: true, generation: true },
  });

const identitiesOf = async (name: string) =>
  (
    await db.policyRuleV2.findMany({
      where: { organizationId: ORG, name },
      include: { identities: true },
    })
  ).map((r) => r.identities.map((i) => i.userId ?? i.groupId).sort());

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  policy = await import("./policy-service");
  // Directory identities (users, groups) are licensed on self-host.
  initEntitlementForTests(true);
});

afterAll(async () => {
  initEntitlementForTests(null);
  if (!PROOF_URL) return;
  await reset();
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  // The rule-action gate is not under test (directory identities are
  // plan-gated on cloud); give every write the permissive default.
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
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
  await makeUser(OWNER);
  await makeUser(BYSTANDER);
});

describe.skipIf(!PROOF_URL)(
  "deleting a group drops the rules naming only it",
  () => {
    const deleteGroup = async (groupId: string) =>
      (await import("../ee/services/group-service")).deleteGroup(ORG, groupId);

    it("a non-member stays blocked past the org's deny default", async () => {
      await makeGroup(GROUP);
      await policy.setPolicyDefaultAction(ORG_SCOPE, "block");
      await rule(ORG_SCOPE, "only G reaches x", "allow", "x.example.test", [
        { type: "group", id: GROUP },
      ]);
      await publish();
      const outsider = { userIds: [BYSTANDER] };
      expect(await decide("x.example.test", outsider)).toMatchObject({
        action: "block",
        byDefault: true,
      });

      await deleteGroup(GROUP);

      // The bug: the identity-less allow matched everyone (`action: "allow"`).
      expect(await decide("x.example.test", outsider)).toMatchObject({
        action: "block",
        byDefault: true,
      });
      expect(await everyoneRules()).toEqual([]);
    });

    it("a rule naming another group too keeps it; an authored 'everyone' rule and another org stay", async () => {
      await makeGroup(GROUP);
      await makeGroup(OTHER_GROUP);
      await makeGroup(FOREIGN_GROUP, OTHER_ORG);
      await rule(ORG_SCOPE, "shared", "block", "s.example.test", [
        { type: "group", id: GROUP },
        { type: "group", id: OTHER_GROUP },
      ]);
      await rule(ORG_SCOPE, "everyone", "block", "e.example.test");
      await rule(
        { organizationId: OTHER_ORG },
        "foreign",
        "block",
        "f.example.test",
        [{ type: "group", id: FOREIGN_GROUP }],
      );
      await publish();
      await publish(OTHER_ORG);

      await deleteGroup(GROUP);

      // Draft + live copy, each keeping only the surviving group.
      expect(await identitiesOf("shared")).toEqual([
        [OTHER_GROUP],
        [OTHER_GROUP],
      ]);
      expect(
        await db.policyRuleV2.count({
          where: { organizationId: ORG, name: "everyone" },
        }),
      ).toBe(2);
      expect(
        await db.policyRuleV2.count({
          where: { organizationId: OTHER_ORG, name: "foreign" },
        }),
      ).toBe(2);
    });

    it("only ever touches the group's own organization: planted control", async () => {
      // The write path refuses a foreign group (`assertIdentitiesValid`), but
      // the schema does not, so plant one directly: a rule in ANOTHER org that
      // names this group. Deleting the group must leave that org alone.
      await makeGroup(GROUP);
      await db.policyRuleV2.create({
        data: {
          scope: "organization",
          organizationId: OTHER_ORG,
          status: "draft",
          priority: 1,
          name: "planted",
          action: "block",
          identities: { create: [{ groupId: GROUP }] },
          targets: {
            create: [{ kind: "network", hostPattern: "p.example.test" }],
          },
        },
      });

      await deleteGroup(GROUP);

      expect(
        await db.policyRuleV2.count({
          where: { organizationId: OTHER_ORG, name: "planted" },
        }),
      ).toBe(1);
    });

    it("cleans every retained generation and publishes nothing", async () => {
      await makeGroup(GROUP);
      await makeGroup(OTHER_GROUP);
      const survivor: Identity[] = [{ type: "group", id: OTHER_GROUP }];
      await rule(ORG_SCOPE, "group block", "block", "g.example.test", [
        { type: "group", id: GROUP },
      ]);
      await publish();
      // A second generation: the first stays behind as a rollback target that
      // still names the group.
      await rule(ORG_SCOPE, "filler", "block", "filler.example.test", survivor);
      await publish();
      // Staged, unpublished.
      await rule(ORG_SCOPE, "staged", "block", "staged.example.test", survivor);
      const before = await db.policyRuleV2.aggregate({
        where: { organizationId: ORG, status: "published" },
        _max: { generation: true },
      });
      expect(before._max.generation).toBe(2);

      await deleteGroup(GROUP);

      expect(await everyoneRules()).toEqual([]);
      expect(
        await db.policyRuleV2.count({
          where: { organizationId: ORG, name: "group block" },
        }),
      ).toBe(0);
      const after = await db.policyRuleV2.aggregate({
        where: { organizationId: ORG, status: "published" },
        _max: { generation: true },
      });
      expect(after._max.generation).toBe(2);
      expect(
        await db.policyRuleV2.count({
          where: { organizationId: ORG, status: "published", name: "staged" },
        }),
      ).toBe(0);
    });

    it("a SCIM group delete takes the same path", async () => {
      await makeGroup(GROUP);
      await db.group.update({ where: { id: GROUP }, data: { source: "scim" } });
      await rule(ORG_SCOPE, "scim group block", "block", "g.example.test", [
        { type: "group", id: GROUP },
      ]);
      await publish();

      const { scimDeleteGroup } =
        await import("../ee/services/org-directory-service");
      await scimDeleteGroup(ORG, GROUP);

      expect(await everyoneRules()).toEqual([]);
    });

    it("never deadlocks against concurrent rule writes", async () => {
      for (let round = 0; round < 5; round++) {
        const victim = `${GROUP}-${round}`;
        await makeGroup(victim);
        await rule(ORG_SCOPE, `victim ${round}`, "block", "v.example.test", [
          { type: "group", id: victim },
        ]);
        const results = await Promise.allSettled([
          rule(ORG_SCOPE, `racer ${round}`, "block", "r.example.test", [
            { type: "group", id: victim },
          ]),
          deleteGroup(victim),
          publish(),
        ]);
        const errors = results
          .filter((r) => r.status === "rejected")
          .map((r) => String((r as PromiseRejectedResult).reason));
        // The racer may lose (its group is gone); a deadlock must never appear.
        expect(errors.join("\n")).not.toMatch(/deadlock/i);
        expect(results[1]?.status).toBe("fulfilled");
      }
      expect(await everyoneRules()).toEqual([]);
    });
  },
);

describe.skipIf(!PROOF_URL)(
  "deleting a user drops the rules naming only them",
  () => {
    it("account deletion: other users are no longer blocked by the leaver's rule", async () => {
      await makeUser(LEAVER, [ORG, OTHER_ORG]);
      await rule(ORG_SCOPE, "block leaver", "block", "y.example.test", [
        { type: "user", id: LEAVER },
      ]);
      await rule(ORG_SCOPE, "shared", "block", "s.example.test", [
        { type: "user", id: LEAVER },
        { type: "user", id: BYSTANDER },
      ]);
      // Named in a SECOND org's rules too.
      await rule(
        { organizationId: OTHER_ORG },
        "other org",
        "block",
        "o.example.test",
        [{ type: "user", id: LEAVER }],
      );
      await publish();
      await publish(OTHER_ORG);
      const bystander = { userIds: [BYSTANDER] };
      expect(await decide("y.example.test", bystander)).toEqual({
        action: "allow",
      });

      const { deleteAccount } = await import("./account-deletion-service");
      await deleteAccount({
        userId: LEAVER,
        userEmail: `${LEAVER}@example.test`,
      });

      // The bug: the identity-less block matched everyone (`action: "block"`).
      expect(await decide("y.example.test", bystander)).toEqual({
        action: "allow",
      });
      expect(await everyoneRules()).toEqual([]);
      expect(await everyoneRules(OTHER_ORG)).toEqual([]);
      expect(await identitiesOf("shared")).toEqual([[BYSTANDER], [BYSTANDER]]);
      expect(await db.user.count({ where: { id: LEAVER } })).toBe(0);
    });

    it("returns exactly the orgs whose rules changed, for the gateway flush", async () => {
      await makeUser(LEAVER, [ORG, OTHER_ORG]);
      await rule(ORG_SCOPE, "block leaver", "block", "y.example.test", [
        { type: "user", id: LEAVER },
      ]);
      await rule(
        { organizationId: OTHER_ORG },
        "other org",
        "block",
        "o.example.test",
        [{ type: "user", id: LEAVER }],
      );
      // A rule merely SHARING the user loses only the identity, not the rule.
      await rule(ORG_SCOPE, "shared", "block", "s.example.test", [
        { type: "user", id: LEAVER },
        { type: "user", id: BYSTANDER },
      ]);

      const changed = await db.$transaction((tx) =>
        policy.dropPrincipalFromPolicyInTx(tx, { kind: "user", id: LEAVER }),
      );

      expect(changed).toEqual([ORG, OTHER_ORG].sort());
    });

    it("a placeholder user's rules go with it", async () => {
      await makeUser(LEAVER);
      await rule(ORG_SCOPE, "placeholder block", "block", "p.example.test", [
        { type: "user", id: LEAVER },
      ]);
      await publish();
      await db.organizationMember.deleteMany({ where: { userId: LEAVER } });

      const { deletePlaceholderUser } =
        await import("../ee/services/user-service");
      const flush = await db.$transaction((tx) =>
        deletePlaceholderUser(LEAVER, tx),
      );
      flush();

      expect(await everyoneRules()).toEqual([]);
      expect(await db.user.count({ where: { id: LEAVER } })).toBe(0);
    });
  },
);

/**
 * The race the row lock closes, made deterministic: a rule write naming the
 * principal is IN FLIGHT (its identity inserted, its transaction still open)
 * when the delete runs. Not every rule writer takes the scope lock
 * (`updatePolicyRule` doesn't), so only the principal's row lock orders them:
 * the delete's `FOR UPDATE` waits on the writer's FK share lock, then sees and
 * removes the identity-only rule. Without it the delete misses the uncommitted
 * row, the writer commits, and the cascade leaves an "everyone" rule.
 */
describe.skipIf(!PROOF_URL)(
  "a rule write in flight during the delete never leaves an orphan",
  () => {
    /** Insert an identity naming the principal on a fresh rule, and hold the
     * transaction open until `release` is called. */
    const holdIdentityWrite = async (identity: {
      userId?: string;
      groupId?: string;
    }) => {
      const ruleRow = await db.policyRuleV2.create({
        data: {
          scope: "organization",
          organizationId: ORG,
          status: "draft",
          priority: 90,
          name: "in flight",
          action: "block",
          targets: {
            create: [{ kind: "network", hostPattern: "f.example.test" }],
          },
        },
      });
      let release = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      let inserted = () => {};
      const insertedSignal = new Promise<void>((r) => (inserted = r));
      const writer = db.$transaction(
        async (tx) => {
          await tx.policyRuleIdentity.create({
            data: { ruleId: ruleRow.id, ...identity },
          });
          inserted();
          await released;
        },
        { timeout: 20_000 },
      );
      await insertedSignal;
      return { writer, release };
    };

    it("group", async () => {
      await makeGroup(GROUP);
      const { writer, release } = await holdIdentityWrite({ groupId: GROUP });
      const deleting = (
        await import("../ee/services/group-service")
      ).deleteGroup(ORG, GROUP);
      // Let the delete reach its row lock, then commit the writer.
      await new Promise((r) => setTimeout(r, 300));
      release();
      await writer;
      await deleting;

      expect(await everyoneRules()).toEqual([]);
    });

    it("user", async () => {
      await makeUser(LEAVER);
      // The user arm locks the orgs whose rules already name the user, so
      // give it one, then race a second write.
      await rule(ORG_SCOPE, "existing", "block", "e.example.test", [
        { type: "user", id: LEAVER },
      ]);
      const { writer, release } = await holdIdentityWrite({ userId: LEAVER });
      const { deleteAccount } = await import("./account-deletion-service");
      const deleting = deleteAccount({
        userId: LEAVER,
        userEmail: `${LEAVER}@example.test`,
      });
      await new Promise((r) => setTimeout(r, 300));
      release();
      await writer;
      await deleting;

      expect(await everyoneRules()).toEqual([]);
    });
  },
);
