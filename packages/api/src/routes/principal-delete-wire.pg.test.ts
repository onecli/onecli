/**
 * Acceptance walk for deleted principals over the REAL public interfaces:
 * the `/v1` routes the dashboard, CLI and SDK call (through `createApiApp`
 * with a signed-in org owner) and the SCIM endpoint an identity provider
 * calls (through `createScimApp` with a minted SCIM token), on real
 * PostgreSQL. Everything a caller does and reads goes over HTTP:
 *
 *  1. An admin writes org rules naming a group and a user
 *     (POST /v1/org/policy/rules) and publishes them (POST .../publish).
 *  2. The group is deleted from the dashboard (DELETE /v1/org/groups/:id):
 *     no published rule is left naming no one, and a rule shared with
 *     another group keeps it (GET /v1/org/policy/rules?status=published).
 *  3. A SCIM-managed group is deleted by the IdP (DELETE /scim/v2/Groups/:id):
 *     same outcome.
 *  4. A member deletes their own account (DELETE /v1/user): their rule goes,
 *     a rule shared with the owner keeps the owner.
 *
 * "No rule naming no one" is the property the bug broke: an identity-less
 * rule applies to everyone in the gateway's engine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initEntitlementForTests } from "../lib/entitlements";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;
let scim: ReturnType<typeof import("../ee/scim").createScimApp>;
let scimToken = "";

const P = "pdwire-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const OWNER = `${P}owner`;
const MEMBER = `${P}member`;
const SELF_URL = "https://api.pdwire.test";

let currentSession: { id: string; email: string } | null = null;
const as = (userId: string) => {
  currentSession = { id: userId, email: `${userId}@example.com` };
};

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: {
      "x-workspace-id": WORKSPACE,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text ? (JSON.parse(text) as unknown) : null,
  };
};

interface RuleDto {
  name: string;
  identities: { type: string; id: string }[];
}

const createRule = async (
  name: string,
  identities: { type: "user" | "group"; id: string }[],
) => {
  const res = await call("POST", "/v1/org/policy/rules", {
    name,
    action: "block",
    identities,
    targets: [{ kind: "network", hostPattern: `${name}.example.test` }],
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
};

const publish = async () => {
  const res = await call("POST", "/v1/org/policy/publish");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
};

/** The published rule set, as the API reports it. */
const publishedRules = async () => {
  as(OWNER);
  const res = await call("GET", "/v1/org/policy/rules?status=published");
  expect(res.status).toBe(200);
  return (res.json as RuleDto[]).filter((r) => r.identities !== undefined);
};

const createGroup = async (name: string) => {
  const res = await call("POST", "/v1/org/groups", { name });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return (res.json as { id: string }).id;
};

const cleanup = async () => {
  await db.policyRuleV2.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({
    where: { OR: [{ organizationId: ORG }, { userId: { startsWith: P } }] },
  });
  await db.groupMember.deleteMany({
    where: { group: { organizationId: ORG } },
  });
  await db.group.deleteMany({ where: { organizationId: ORG } });
  await db.organizationScimToken.deleteMany({ where: { organizationId: ORG } });
  await db.workspaceAccess.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  // Hermetic: the gateway cache flush is an outbound call.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
  // Groups, user identities and SCIM are licensed on self-host.
  initEntitlementForTests(true);
  ({ db } = await import("@onecli/db"));
  const providers = await import("../providers");
  providers.initSelfUrl(SELF_URL);
  const { createApiApp } = await import("../app");
  app = createApiApp(
    { getSession: async () => currentSession },
    { selfUrl: SELF_URL },
  );
  scim = (await import("../ee/scim")).createScimApp();

  await cleanup();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
  for (const [id, role] of [
    [OWNER, "owner"],
    [MEMBER, "member"],
  ] as const) {
    await db.user.create({
      data: {
        id,
        email: `${id}@example.com`,
        externalAuthId: id,
        name: id,
      },
    });
    await db.organizationMember.create({
      data: {
        organizationId: ORG,
        userId: id,
        userEmail: `${id}@example.com`,
        role,
      },
    });
  }
  await db.workspaceAccess.create({
    data: { workspaceId: WORKSPACE, userId: OWNER, role: "owner" },
  });
  const { createScimToken } = await import("../ee/services/scim-token-service");
  scimToken = (await createScimToken(ORG, "wire", OWNER)).token;
});

afterAll(async () => {
  initEntitlementForTests(null);
  vi.unstubAllGlobals();
  if (!PROOF_URL) return;
  await cleanup();
});

describe.skipIf(!PROOF_URL)("deleted principals over the public API", () => {
  it("a dashboard group delete leaves no rule naming no one", async () => {
    as(OWNER);
    const doomed = await createGroup("doomed");
    const kept = await createGroup("kept");
    await createRule("only-doomed", [{ type: "group", id: doomed }]);
    await createRule("shared", [
      { type: "group", id: doomed },
      { type: "group", id: kept },
    ]);
    await publish();

    const res = await call("DELETE", `/v1/org/groups/${doomed}`);
    expect(res.status).toBe(204);

    const rules = await publishedRules();
    expect(rules.filter((r) => r.identities.length === 0)).toEqual([]);
    expect(rules.find((r) => r.name === "only-doomed")).toBeUndefined();
    expect(rules.find((r) => r.name === "shared")?.identities).toEqual([
      { type: "group", id: kept },
    ]);
  });

  it("a SCIM group delete by the identity provider does the same", async () => {
    const created = await scim.request("/Groups", {
      method: "POST",
      headers: {
        authorization: `Bearer ${scimToken}`,
        "content-type": "application/scim+json",
      },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: "idp-group",
      }),
    });
    expect(created.status).toBe(201);
    const groupId = ((await created.json()) as { id: string }).id;
    as(OWNER);
    await createRule("only-idp", [{ type: "group", id: groupId }]);
    await publish();

    const res = await scim.request(`/Groups/${groupId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${scimToken}` },
    });
    expect(res.status).toBe(204);

    const rules = await publishedRules();
    expect(rules.filter((r) => r.identities.length === 0)).toEqual([]);
    expect(rules.find((r) => r.name === "only-idp")).toBeUndefined();
  });

  it("deleting your own account leaves no rule naming no one", async () => {
    as(OWNER);
    await createRule("only-member", [{ type: "user", id: MEMBER }]);
    await createRule("member-and-owner", [
      { type: "user", id: MEMBER },
      { type: "user", id: OWNER },
    ]);
    await publish();

    as(MEMBER);
    const res = await call("DELETE", "/v1/user");
    expect(res.status).toBe(204);

    const rules = await publishedRules();
    expect(rules.filter((r) => r.identities.length === 0)).toEqual([]);
    expect(rules.find((r) => r.name === "only-member")).toBeUndefined();
    expect(
      rules.find((r) => r.name === "member-and-owner")?.identities,
    ).toEqual([{ type: "user", id: OWNER }]);
  });
});
