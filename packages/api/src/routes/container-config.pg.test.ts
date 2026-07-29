import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * `injectableSecretWhere` on REAL PostgreSQL.
 *
 * Two properties that only a database can settle, and neither had a guard:
 *
 *  1. The FENCE. A selective agent's grants name secret ids; the gateway resolves
 *     them by retaining from the org/project-fenced pool, so a rule naming a
 *     foreign secret yields nothing. Fencing the rules does not fence their
 *     target ids — this asserts the query itself is fenced.
 *  2. PRECEDENCE. The gateway merges its all-mode pool partner → org → project
 *     with later injections overriding, so the project secret is the one actually
 *     injected. An unordered `findFirst` over an OR returns whatever Postgres
 *     reaches first, which is how the container ends up with an org secret's auth
 *     mode while the gateway injects the project's.
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
const PROJECT = `${P}proj`;
const OTHER_PROJECT = `${P}other-proj`;
const AGENT = `${P}agent`;

const secret = (
  id: string,
  over: Partial<{
    projectId: string | null;
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
  scope: over.scope ?? "project",
  projectId: over.projectId === undefined ? PROJECT : over.projectId,
  organizationId: over.organizationId ?? null,
  metadata: { authMode: over.authMode ?? "api-key" },
});

/** A published equipment rule granting `secretId` to the agent. */
const grant = async (logicalId: string, secretId: string) => {
  await db.policyRuleV2.create({
    data: {
      scope: "project",
      projectId: PROJECT,
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

const resolve = async (secretMode: string) =>
  route.injectableSecretWhere({ id: AGENT, secretMode }, PROJECT, ORG);

const matchedIds = async (secretMode: string): Promise<string[]> => {
  const where = await resolve(secretMode);
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
  await db.project.deleteMany({ where: { id: { startsWith: P } } });
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
  await db.project.create({
    data: { id: PROJECT, name: PROJECT, organizationId: ORG },
  });
  await db.project.create({
    data: { id: OTHER_PROJECT, name: OTHER_PROJECT, organizationId: OTHER_ORG },
  });
  await db.agent.create({
    data: {
      id: AGENT,
      projectId: PROJECT,
      name: AGENT,
      identifier: AGENT,
      accessToken: `aoc_${P}`,
      secretMode: "all",
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
    it("all-mode takes the org+project pool and nothing outside it", async () => {
      await db.secret.createMany({
        data: [
          secret(`${P}mine`),
          secret(`${P}org`, {
            projectId: null,
            organizationId: ORG,
            scope: "organization",
          }),
          // Another org's secret, and another project's — neither is reachable.
          secret(`${P}foreign-org`, {
            projectId: null,
            organizationId: OTHER_ORG,
            scope: "organization",
          }),
          secret(`${P}foreign-proj`, { projectId: OTHER_PROJECT }),
        ],
      });
      await expect(matchedIds("all")).resolves.toEqual([`${P}mine`, `${P}org`]);
    });

    it("a selective agent gets ONLY what its rules grant", async () => {
      await db.secret.createMany({
        data: [secret(`${P}granted`), secret(`${P}ungranted`)],
      });
      await grant(`${P}g1`, `${P}granted`);
      await expect(matchedIds("selective")).resolves.toEqual([`${P}granted`]);
    });

    it("a selective agent with NO grant gets nothing — never the pool", async () => {
      await db.secret.create({ data: secret(`${P}mine`) });
      await expect(matchedIds("selective")).resolves.toEqual([]);
    });

    it("CROSS-ORG BAIT: a grant naming a foreign secret resolves to nothing", async () => {
      // The fence has to live in the QUERY. A rule can name any id — these rows
      // were materialized by the retired bridge, not through the validating write
      // path — so trusting the rule's own scope would leak another org's secret.
      await db.secret.createMany({
        data: [
          secret(`${P}foreign-org`, {
            projectId: null,
            organizationId: OTHER_ORG,
            scope: "organization",
          }),
          secret(`${P}foreign-proj`, { projectId: OTHER_PROJECT }),
        ],
      });
      await grant(`${P}g-bait-1`, `${P}foreign-org`);
      await grant(`${P}g-bait-2`, `${P}foreign-proj`);
      await expect(matchedIds("selective")).resolves.toEqual([]);
    });

    it("a whole-level grant matches by the secret's own scope, still fenced", async () => {
      await db.secret.createMany({
        data: [
          secret(`${P}mine`),
          secret(`${P}org`, {
            projectId: null,
            organizationId: ORG,
            scope: "organization",
          }),
          secret(`${P}foreign-proj`, { projectId: OTHER_PROJECT }),
        ],
      });
      await db.policyRuleV2.create({
        data: {
          scope: "project",
          projectId: PROJECT,
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
          targets: { create: [{ kind: "secret", secretScope: "project" }] },
        },
      });
      // The other project's secret is also scope="project" — only the fence keeps
      // it out.
      await expect(matchedIds("selective")).resolves.toEqual([`${P}mine`]);
    });

    it("PRECEDENCE: the project secret wins over an org one of the same type", async () => {
      // Insert the org row FIRST so an unordered findFirst would return it. The
      // gateway injects the project secret (its all-mode merge puts project last
      // and later overrides earlier), so the container must read the project's
      // auth mode or it is configured for the wrong credential.
      await db.secret.create({
        data: secret(`${P}org-oauth`, {
          projectId: null,
          organizationId: ORG,
          scope: "organization",
          authMode: "oauth",
        }),
      });
      await db.secret.create({
        data: secret(`${P}proj-apikey`, { authMode: "api-key" }),
      });

      // Goes through the route's own resolver — asserting an ordering the test
      // supplies itself would pass with the ordering removed from the code.
      const picked = await route.findInjectableSecretOfType(
        await resolve("all"),
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
