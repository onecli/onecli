import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * `injectableSecretWhere` on REAL PostgreSQL.
 *
 * Two properties that only a database can settle, and neither had a guard:
 *
 *  1. The FENCE. An agent's grants name secret ids; the gateway resolves them
 *     by retaining from the org/workspace-fenced pool, so a rule naming a
 *     foreign secret yields nothing. Fencing the rules does not fence their
 *     target ids — this asserts the query itself is fenced.
 *  2. PRECEDENCE. The gateway merges org → workspace with later
 *     injections overriding, so the workspace secret is the one actually
 *     injected. An unordered `findFirst` over an OR returns whatever Postgres
 *     reaches first, which is how the container ends up with an org secret's
 *     auth mode while the gateway injects the workspace's.
 *
 * Env-gated like the other proof suites; see app-blocklist-service.pg.test.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Route = typeof import("./container-config");

let db: Db;
let route: Route;

const P = "ccfg-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WORKSPACE = `${P}proj`;
const OTHER_WORKSPACE = `${P}other-proj`;
const AGENT = `${P}agent`;

const secret = (
  id: string,
  over: Partial<{
    workspaceId: string | null;
    organizationId: string | null;
    scope: string;
    type: string;
    authMode: string;
  }> = {},
) => ({
  id,
  name: id,
  type: over.type ?? "anthropic",
  encryptedValue: "x",
  hostPattern: "api.anthropic.com",
  scope: over.scope ?? "workspace",
  workspaceId: over.workspaceId === undefined ? WORKSPACE : over.workspaceId,
  organizationId: over.organizationId ?? null,
  metadata: { authMode: over.authMode ?? "api-key" },
});

/** A published equipment rule granting `secretId` to the agent. */
const grant = async (logicalId: string, secretId: string) => {
  await db.policyRuleV2.create({
    data: {
      scope: "workspace",
      workspaceId: WORKSPACE,
      status: "published",
      generation: 1,
      priority: 10,
      isDefault: false,
      enabled: true,
      source: "equipment",
      logicalId,
      name: logicalId,
      action: "allow",
      requireApproval: false,
      identities: { create: [{ agentId: AGENT }] },
      targets: { create: [{ kind: "secret", secretId }] },
    },
  });
};

const resolve = async () =>
  route.injectableSecretWhere({ id: AGENT }, WORKSPACE, ORG);

const matchedIds = async (): Promise<string[]> => {
  const where = await resolve();
  const rows = await db.secret.findMany({ where, select: { id: true } });
  return rows.map((r) => r.id).sort();
};

const reset = async () => {
  await db.policyRuleTarget.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.secret.deleteMany({ where: { id: { startsWith: P } } });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  route = await import("./container-config");
  await reset();
  for (const id of [ORG, OTHER_ORG]) {
    await db.organization.create({ data: { id, name: id, slug: id } });
  }
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
  await db.workspace.create({
    data: {
      id: OTHER_WORKSPACE,
      name: OTHER_WORKSPACE,
      organizationId: OTHER_ORG,
    },
  });
  await db.agent.create({
    data: {
      id: AGENT,
      workspaceId: WORKSPACE,
      name: AGENT,
      identifier: AGENT,
      accessToken: `aoc_${P}`,
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.policyRuleTarget.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleIdentity.deleteMany({
    where: { rule: { logicalId: { startsWith: P } } },
  });
  await db.policyRuleV2.deleteMany({ where: { logicalId: { startsWith: P } } });
  await db.secret.deleteMany({ where: { id: { startsWith: P } } });
});

describe.skipIf(!PROOF_URL)(
  "injectableSecretWhere over real PostgreSQL",
  () => {
    it("an agent gets ONLY what its rules grant", async () => {
      await db.secret.createMany({
        data: [secret(`${P}granted`), secret(`${P}ungranted`)],
      });
      await grant(`${P}g1`, `${P}granted`);
      await expect(matchedIds()).resolves.toEqual([`${P}granted`]);
    });

    it("an agent with NO grant gets nothing — never the pool", async () => {
      await db.secret.create({ data: secret(`${P}mine`) });
      await expect(matchedIds()).resolves.toEqual([]);
    });

    it("CROSS-ORG BAIT: a grant naming a foreign secret resolves to nothing", async () => {
      // The fence has to live in the QUERY. A rule can name any id — these rows
      // were materialized by the retired bridge, not through the validating write
      // path — so trusting the rule's own scope would leak another org's secret.
      await db.secret.createMany({
        data: [
          secret(`${P}foreign-org`, {
            workspaceId: null,
            organizationId: OTHER_ORG,
            scope: "organization",
          }),
          secret(`${P}foreign-proj`, { workspaceId: OTHER_WORKSPACE }),
        ],
      });
      await grant(`${P}g-bait-1`, `${P}foreign-org`);
      await grant(`${P}g-bait-2`, `${P}foreign-proj`);
      await expect(matchedIds()).resolves.toEqual([]);
    });

    it("a whole-level grant matches by the secret's own scope, still fenced", async () => {
      await db.secret.createMany({
        data: [
          secret(`${P}mine`),
          secret(`${P}org`, {
            workspaceId: null,
            organizationId: ORG,
            scope: "organization",
          }),
          secret(`${P}foreign-proj`, { workspaceId: OTHER_WORKSPACE }),
        ],
      });
      await db.policyRuleV2.create({
        data: {
          scope: "workspace",
          workspaceId: WORKSPACE,
          status: "published",
          generation: 1,
          priority: 10,
          isDefault: false,
          enabled: true,
          source: "equipment",
          logicalId: `${P}g-level`,
          name: "level grant",
          action: "allow",
          requireApproval: false,
          identities: { create: [{ agentId: AGENT }] },
          targets: { create: [{ kind: "secret", secretScope: "workspace" }] },
        },
      });
      // The other workspace's secret is also scope="workspace" — only the fence keeps
      // it out.
      await expect(matchedIds()).resolves.toEqual([`${P}mine`]);
    });

    it("PRECEDENCE: the workspace secret wins over an org one of the same type", async () => {
      // Insert the org row FIRST so an unordered findFirst would return it. The
      // gateway's merge puts workspace last with later overriding earlier, so the
      // container must read the workspace's auth mode or it is configured for the
      // wrong credential. Both rows are granted — precedence is only visible
      // when more than one secret is reachable at all.
      await db.secret.create({
        data: secret(`${P}org-oauth`, {
          workspaceId: null,
          organizationId: ORG,
          scope: "organization",
          authMode: "oauth",
        }),
      });
      await db.secret.create({
        data: secret(`${P}proj-apikey`, { authMode: "api-key" }),
      });
      await grant(`${P}g-org`, `${P}org-oauth`);
      await grant(`${P}g-proj`, `${P}proj-apikey`);

      // Goes through the route's own resolver — asserting an ordering the test
      // supplies itself would pass with the ordering removed from the code.
      const picked = await route.findInjectableSecretOfType(
        await resolve(),
        "anthropic",
        { id: true, metadata: true },
      );
      expect(picked?.id).toBe(`${P}proj-apikey`);
      expect((picked?.metadata as { authMode: string })?.authMode).toBe(
        "api-key",
      );
    });
  },
);
