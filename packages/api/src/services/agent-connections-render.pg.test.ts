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
  await db.secret.deleteMany({ where: { id: { startsWith: P } } });
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
    // The injection-law fields exactly; the catalog facts ride alongside.
    expect(list).toMatchObject([
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
    expect(list).toHaveLength(3);
    // Catalog facts: a fixed-host app gets its API host and docs; a
    // tenant-only app gets none (its bound host above is the answer).
    expect(list[0]).toMatchObject({
      apiHosts: ["gmail.googleapis.com"],
      docsUrl:
        "https://developers.google.com/workspace/gmail/api/reference/rest",
    });
    expect(list[1]?.apiHosts).toEqual([]);
    // Another agent in the same workspace holds no grant — sees nothing.
    expect(await render.connectionsForRender(OTHER_AGENT)).toEqual([]);
  });

  it("drops a connection once its grant is removed", async () => {
    await grants.removeConnectionGrant(SCOPE, AGENT, GMAIL, null);
    const list = await render.connectionsForRender(AGENT);
    expect(list.map((c) => c.provider)).toEqual(["salesforce", "snowflake"]);
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

describe.skipIf(!PROOF_URL)(
  "customConnectionsForRender over real PostgreSQL",
  () => {
    const KEY_A = `${P}sec-a`;
    const KEY_B = `${P}sec-b`;
    const LLM = `${P}sec-llm`;
    const FOREIGN_SEC = `${P}sec-foreign`;

    it("lists granted custom secrets with host and path, never values", async () => {
      const secret = (id: string, over: Record<string, unknown>) =>
        db.secret.create({
          data: {
            id,
            name: id,
            scope: "workspace",
            workspaceId: WORKSPACE,
            type: "generic",
            valueSource: "inline",
            encryptedValue: "SECRET-CIPHERTEXT",
            hostPattern: "api.example.com",
            injectionConfig: { headerName: "x-api-key" },
            metadata: { note: "SECRET-METADATA" },
            ...over,
          } as never,
        });
      await secret(KEY_A, { name: "Staging\u0007 key" });
      await secret(KEY_B, { name: "Prod key", pathPattern: "/v2/*" });
      await secret(LLM, {
        type: "anthropic",
        hostPattern: "api.anthropic.com",
      });
      await secret(FOREIGN_SEC, { workspaceId: OTHER_WORKSPACE });

      expect(await render.customConnectionsForRender(AGENT)).toEqual([]);
      for (const id of [KEY_A, KEY_B, LLM]) {
        await grants.setSecretGrant(SCOPE, AGENT, id, null);
      }

      const list = await render.customConnectionsForRender(AGENT);
      expect(list).toEqual([
        { id: KEY_A, name: "Staging key", host: "api.example.com" },
        { id: KEY_B, name: "Prod key", host: "api.example.com", path: "/v2/*" },
      ]);
      const wire = JSON.stringify(list);
      expect(wire).not.toContain("SECRET-CIPHERTEXT");
      expect(wire).not.toContain("SECRET-METADATA");
      // The ungranted agent and the foreign workspace's secret stay invisible.
      expect(await render.customConnectionsForRender(OTHER_AGENT)).toEqual([]);
    });

    it("a workspace-level grant lists own-scope secrets, never a foreign org's", async () => {
      const ORG_SEC = `${P}sec-org`;
      const FOREIGN_ORG_SEC = `${P}sec-foreign-org`;
      await db.organization.upsert({
        where: { id: OTHER_ORG },
        create: { id: OTHER_ORG, name: OTHER_ORG, slug: OTHER_ORG },
        update: {},
      });
      const base = {
        type: "generic",
        valueSource: "inline",
        encryptedValue: "SECRET-CIPHERTEXT",
        hostPattern: "api.example.com",
        injectionConfig: { headerName: "x-api-key" },
      };
      await db.secret.create({
        data: {
          ...base,
          id: ORG_SEC,
          name: "\u202eOrg key",
          scope: "organization",
          organizationId: ORG,
        } as never,
      });
      await db.secret.create({
        data: {
          ...base,
          id: FOREIGN_ORG_SEC,
          name: "Foreign org key",
          scope: "organization",
          organizationId: OTHER_ORG,
        } as never,
      });
      // Level grants (secret_scopes): every workspace secret and every org
      // secret, but only in THIS agent's workspace/org pool.
      await plantRule(
        { workspaceId: WORKSPACE },
        { kind: "secret", secretScope: "workspace" },
      );
      await plantRule(
        { organizationId: ORG },
        { kind: "secret", secretScope: "organization" },
      );

      const ids = (await render.customConnectionsForRender(AGENT)).map(
        (c) => c.id,
      );
      expect(ids).toContain(ORG_SEC);
      expect(ids).toContain(KEY_A);
      expect(ids).not.toContain(FOREIGN_ORG_SEC);
      expect(ids).not.toContain(FOREIGN_SEC);
      const org = (await render.customConnectionsForRender(AGENT)).find(
        (c) => c.id === ORG_SEC,
      );
      expect(org?.name).toBe("Org key");
    });
  },
);
