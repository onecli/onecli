import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * `connectionsForRender` on REAL PostgreSQL, through the real grant compiler:
 * the agent's instructions list exactly the connections the gateway would
 * inject for it, with a host-bound app's host read from non-secret metadata.
 * The Salesforce incident this exists for: the agent held the credential,
 * did not know the org's My Domain, and guessed `login.salesforce.com`.
 *
 * Env-gated like the other proof suites; see load-rules.pg.test.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let grants: typeof import("./grants-service");
let render: typeof import("./agent-connections-render");

const P = "acr-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OTHER_WORKSPACE = `${P}other-ws`;
const AGENT = `${P}agent`;
const OTHER_AGENT = `${P}other-agent`;
const SF = `${P}conn-sf`;
const SNOW = `${P}conn-snow`;
const GMAIL = `${P}conn-gmail`;
const UNGRANTED = `${P}conn-ungranted`;
const FOREIGN = `${P}conn-foreign`;
const OTHER_ORG = `${P}other-org`;
const ORG_CONN = `${P}conn-org`;
const FOREIGN_ORG_CONN = `${P}conn-foreign-org`;
const SCOPE = { workspaceId: WORKSPACE, organizationId: ORG };

const reset = async () => {
  await db.policyRuleV2.deleteMany({
    where: {
      OR: [
        { workspaceId: { startsWith: P } },
        { organizationId: { startsWith: P } },
      ],
    },
  });
  await db.appConnection.deleteMany({ where: { id: { startsWith: P } } });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
  grants = await import("./grants-service");
  render = await import("./agent-connections-render");
  await reset();

  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
    await db.workspace.create({ data: { id, name: id, organizationId: ORG } });
  }
  for (const [id, workspaceId] of [
    [AGENT, WORKSPACE],
    [OTHER_AGENT, WORKSPACE],
  ] as const) {
    await db.agent.create({
      data: {
        id,
        workspaceId,
        name: id,
        identifier: id,
        accessToken: `aoc_${id}`,
      },
    });
  }
  const conn = (id: string, over: Record<string, unknown>) =>
    db.appConnection.create({
      data: {
        id,
        scope: "workspace",
        status: "connected",
        workspaceId: WORKSPACE,
        ...over,
      } as never,
    });
  await conn(SF, {
    provider: "salesforce",
    label: "jane@example.com",
    metadata: { bound_host: "acme.my.salesforce.com" },
  });
  await conn(SNOW, {
    provider: "snowflake",
    label: "acme-prod",
    metadata: { bound_host: "acme-prod.snowflakecomputing.com" },
  });
  await conn(GMAIL, { provider: "gmail", label: "j@example.com" });
  await conn(UNGRANTED, { provider: "dropbox", label: "nobody" });
  await conn(FOREIGN, {
    provider: "salesforce",
    label: "foreign",
    workspaceId: OTHER_WORKSPACE,
    metadata: { bound_host: "foreign.my.salesforce.com" },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

beforeEach(async () => {
  const providers = await import("../providers");
  providers.initRuleActionGate({ assertAllowed: async () => {} });
  providers.initPolicyValidator({ validate: async () => {} });
});

describe.skipIf(!PROOF_URL)("connectionsForRender over real PostgreSQL", () => {
  it("lists only granted connections, with the bound host for host-bound apps", async () => {
    expect(await render.connectionsForRender(AGENT)).toEqual([]);

    await grants.setConnectionGrant(SCOPE, AGENT, SF, { access: "full" }, null);
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      SNOW,
      { access: "full" },
      null,
    );
    await grants.setConnectionGrant(
      SCOPE,
      AGENT,
      GMAIL,
      { access: "full" },
      null,
    );

    const list = await render.connectionsForRender(AGENT);
    expect(list).toEqual([
      { provider: "gmail", name: "Gmail", label: "j@example.com", host: null },
      {
        provider: "salesforce",
        name: "Salesforce",
        label: "jane@example.com",
        host: "acme.my.salesforce.com",
      },
      {
        provider: "snowflake",
        name: "Snowflake",
        label: "acme-prod",
        host: "acme-prod.snowflakecomputing.com",
      },
    ]);
    // Another agent in the same workspace holds no grant — sees nothing.
    expect(await render.connectionsForRender(OTHER_AGENT)).toEqual([]);
  });

  it("drops a connection once its grant is removed", async () => {
    await grants.removeConnectionGrant(SCOPE, AGENT, GMAIL, null);
    const list = await render.connectionsForRender(AGENT);
    expect(list.map((c) => c.provider)).toEqual(["salesforce", "snowflake"]);
  });

  /** A published allow rule naming AGENT, written straight to the table so
   * the test can plant targets the grant API would refuse. */
  const plantRule = (
    base: { workspaceId: string } | { organizationId: string },
    target: Record<string, unknown>,
  ) =>
    db.policyRuleV2.create({
      data: {
        ...("workspaceId" in base
          ? { scope: "workspace", workspaceId: base.workspaceId }
          : { scope: "organization", organizationId: base.organizationId }),
        status: "published",
        generation: 999,
        priority: 1,
        isDefault: false,
        enabled: true,
        source: "custom",
        logicalId: `${P}${Math.random()}`,
        name: "planted",
        action: "allow",
        identities: { create: [{ agent: { connect: { id: AGENT } } }] },
        targets: { create: [target as never] },
      } as never,
    });

  it("never lists another workspace's connection, even when a rule names its id", async () => {
    // MUTATION-PROOF: drop the workspace/org fence from the pool query and
    // FOREIGN (same org, other workspace) shows up here.
    await plantRule(
      { workspaceId: WORKSPACE },
      { kind: "connection", appConnectionId: FOREIGN },
    );
    const list = await render.connectionsForRender(AGENT);
    expect(list.map((c) => c.label)).not.toContain("foreign");
  });

  it("expands a provider-level grant to org connections of THIS org only", async () => {
    await db.organization.create({
      data: { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
    });
    await db.appConnection.create({
      data: {
        id: ORG_CONN,
        provider: "github",
        scope: "organization",
        status: "connected",
        organizationId: ORG,
        label: "org-github",
      },
    });
    await db.appConnection.create({
      data: {
        id: FOREIGN_ORG_CONN,
        provider: "github",
        scope: "organization",
        status: "connected",
        organizationId: OTHER_ORG,
        label: "foreign-org-github",
      },
    });
    await plantRule(
      { organizationId: ORG },
      {
        kind: "app",
        appProvider: "github",
        appConnectionScope: "organization",
      },
    );
    const labels = (await render.connectionsForRender(AGENT)).map(
      (c) => c.label,
    );
    expect(labels).toContain("org-github");
    expect(labels).not.toContain("foreign-org-github");
  });
});
