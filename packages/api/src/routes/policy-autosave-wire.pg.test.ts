/**
 * Acceptance walk for "Global Policy saves without an Apply step", over the
 * REAL public interface the dashboard and CLI call (`createApiApp`, a signed-in
 * org owner) on real PostgreSQL. Every check reads back what the GATEWAY
 * enforces, using the gateway's own query (crates/policy-engine/src/loaders.rs
 * `find_published_policy_rules_v2_by_org`), not the API's view of it.
 *
 *  1. Each write (create, edit, disable, reorder, delete, Default Rule) is
 *     enforced on return: the gateway set changes with no further call.
 *  2. The dashboard's read (GET /rules, no status) equals the enforced set.
 *  3. A rejected write (422 / 409 / 404) changes nothing, neither the draft
 *     nor the enforced set: the in-tx publish rolls back with it.
 *  4. Older CLIs keep working: POST /publish and GET /last-publish answer 200,
 *     and /publish does not change what is enforced.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initEntitlementForTests } from "../lib/entitlements";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
let db: Db;
let app: ReturnType<typeof import("../app").createApiApp>;

const P = "pawire-";
const ORG = `${P}org`;
/** A planted foreign tenant: its rule must read as NOT_FOUND here. */
const FOREIGN_ORG = `${P}foreign-org`;
const FOREIGN_RULE = `${P}foreign-rule`;
const WORKSPACE = `${P}ws`;
const OWNER = `${P}owner`;
const SELF_URL = "https://api.pawire.test";

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
  id: string;
  logicalId: string;
  name: string;
  action: string;
  enabled: boolean;
}

/** What the gateway enforces: its exact query, as `name:action` in order.
 * (The gateway also filters `enabled = true`.) */
const enforced = async () =>
  (
    await db.$queryRaw<{ name: string; action: string; is_default: boolean }[]>`
      SELECT r.name, r.action, r.is_default FROM policy_rules_v2 r
      WHERE r.organization_id = ${ORG} AND r.scope = 'organization'
        AND r.status = 'published' AND r.enabled = true
        AND r.generation = (
          SELECT max(generation) FROM policy_rules_v2
          WHERE organization_id = ${ORG} AND scope = 'organization'
            AND status = 'published')
      ORDER BY r.priority, r.id`
  ).map((r) => `${r.is_default ? "DEFAULT" : r.name}:${r.action}`);

/** The dashboard's read: GET /rules (no status) + GET /default. */
const shown = async () => {
  const rules = await call("GET", "/v1/org/policy/rules");
  const def = await call("GET", "/v1/org/policy/default");
  expect(rules.status).toBe(200);
  expect(def.status).toBe(200);
  return {
    rules: rules.json as RuleDto[],
    default: (def.json as RuleDto).action,
  };
};

/** The shown set, in the same shape as `enforced()` (enabled rules only). */
const shownAsEnforced = async () => {
  const s = await shown();
  return [
    `DEFAULT:${s.default}`,
    ...s.rules.filter((r) => r.enabled).map((r) => `${r.name}:${r.action}`),
  ];
};

const create = async (name: string, action: "allow" | "block" = "block") => {
  const res = await call("POST", "/v1/org/policy/rules", {
    name,
    action,
    targets: [{ kind: "network", hostPattern: `${name}.example.test` }],
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as RuleDto;
};

const cleanup = async () => {
  await db.policyRuleV2.deleteMany({
    where: { organizationId: { in: [ORG, FOREIGN_ORG] } },
  });
  await db.auditLog.deleteMany({
    where: { OR: [{ organizationId: ORG }, { userId: { startsWith: P } }] },
  });
  await db.workspaceAccess.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.organizationMember.deleteMany({ where: { organizationId: ORG } });
  await db.workspace.deleteMany({ where: { id: WORKSPACE } });
  await db.organization.deleteMany({
    where: { id: { in: [ORG, FOREIGN_ORG] } },
  });
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
  initEntitlementForTests(true);
  ({ db } = await import("@onecli/db"));
  const providers = await import("../providers");
  providers.initSelfUrl(SELF_URL);
  const { createApiApp } = await import("../app");
  app = createApiApp(
    { getSession: async () => ({ id: OWNER, email: `${OWNER}@example.com` }) },
    { selfUrl: SELF_URL },
  );

  await cleanup();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.organization.create({
    data: { id: FOREIGN_ORG, name: FOREIGN_ORG, slug: FOREIGN_ORG },
  });
  await db.policyRuleV2.create({
    data: {
      id: FOREIGN_RULE,
      scope: "organization",
      organizationId: FOREIGN_ORG,
      status: "draft",
      generation: 0,
      priority: 1,
      source: "custom",
      name: "foreign",
      action: "block",
      targets: { create: [{ kind: "network", hostPattern: "f.example.test" }] },
    },
  });
  await db.workspace.create({
    data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
  });
  await db.user.create({
    data: {
      id: OWNER,
      email: `${OWNER}@example.com`,
      externalAuthId: OWNER,
      name: OWNER,
    },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: OWNER,
      userEmail: `${OWNER}@example.com`,
      role: "owner",
    },
  });
  await db.workspaceAccess.create({
    data: { workspaceId: WORKSPACE, userId: OWNER, role: "owner" },
  });
});

afterAll(async () => {
  initEntitlementForTests(null);
  vi.unstubAllGlobals();
  if (!PROOF_URL) return;
  await cleanup();
});

describe.skipIf(!PROOF_URL)("Global Policy over the public API", () => {
  it("every write is enforced on return, and the console shows exactly that", async () => {
    // Create: live immediately (the Default Rule is materialized with it).
    const a = await create("alpha");
    expect(await enforced()).toEqual(["DEFAULT:allow", "alpha:block"]);
    const b = await create("beta", "allow");
    expect(await enforced()).toEqual([
      "DEFAULT:allow",
      "alpha:block",
      "beta:allow",
    ]);
    expect(await enforced()).toEqual(await shownAsEnforced());

    // Edit: action + name.
    let res = await call("PATCH", `/v1/org/policy/rules/${a.id}`, {
      name: "alpha2",
      action: "allow",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await enforced()).toEqual([
      "DEFAULT:allow",
      "alpha2:allow",
      "beta:allow",
    ]);

    // Disable: the gateway stops loading it at once.
    res = await call("PATCH", `/v1/org/policy/rules/${b.id}`, {
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(await enforced()).toEqual(["DEFAULT:allow", "alpha2:allow"]);
    res = await call("PATCH", `/v1/org/policy/rules/${b.id}`, {
      enabled: true,
    });
    expect(res.status).toBe(200);

    // Reorder: first-match order changes at once.
    res = await call("PUT", "/v1/org/policy/rules/order", {
      orderedIds: [b.id, a.id],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await enforced()).toEqual([
      "DEFAULT:allow",
      "beta:allow",
      "alpha2:allow",
    ]);

    // Default Rule flip.
    res = await call("PATCH", "/v1/org/policy/default", { action: "block" });
    expect(res.status).toBe(200);
    expect((await enforced())[0]).toBe("DEFAULT:block");

    // Delete.
    res = await call("DELETE", `/v1/org/policy/rules/${b.id}`);
    expect(res.status).toBe(204);
    expect(await enforced()).toEqual(["DEFAULT:block", "alpha2:allow"]);
    expect(await enforced()).toEqual(await shownAsEnforced());
  });

  it("a rejected write changes neither what is shown nor what is enforced", async () => {
    const before = await enforced();
    const shownBefore = await shown();
    const genBefore = await db.policyRuleV2.aggregate({
      where: { organizationId: ORG, status: "published" },
      _max: { generation: true },
    });

    // 422: a rule with no targets, and an edit clearing a rule's targets.
    let res = await call("POST", "/v1/org/policy/rules", {
      name: "bad",
      action: "block",
      targets: [],
    });
    expect(res.status).toBe(422);
    const victim = shownBefore.rules[0]!;
    res = await call("PATCH", `/v1/org/policy/rules/${victim.id}`, {
      targets: [],
    });
    expect(res.status).toBe(422);
    // 409: a stale reorder.
    res = await call("PUT", "/v1/org/policy/rules/order", {
      orderedIds: ["not-a-rule"],
    });
    expect(res.status).toBe(409);
    // 404: a rule that is not there (a double delete), and a planted foreign
    // tenant's rule, which must read exactly the same and stay put.
    res = await call("DELETE", "/v1/org/policy/rules/not-a-rule");
    expect(res.status).toBe(404);
    res = await call("DELETE", `/v1/org/policy/rules/${FOREIGN_RULE}`);
    expect(res.status).toBe(404);
    expect(
      await db.policyRuleV2.count({
        where: { id: FOREIGN_RULE, organizationId: FOREIGN_ORG },
      }),
    ).toBe(1);

    expect(await enforced()).toEqual(before);
    expect(await shown()).toEqual(shownBefore);
    const genAfter = await db.policyRuleV2.aggregate({
      where: { organizationId: ORG, status: "published" },
      _max: { generation: true },
    });
    expect(genAfter._max.generation).toBe(genBefore._max.generation);
  });

  it("older CLIs: /publish and /last-publish still answer, and change nothing", async () => {
    const before = await enforced();
    const pub = await call("POST", "/v1/org/policy/publish", {});
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    expect(await enforced()).toEqual(before);

    const last = await call("GET", "/v1/org/policy/last-publish");
    expect(last.status).toBe(200);
    expect(last.json).toMatchObject({
      appliedBy: { email: `${OWNER}@example.com` },
    });

    // `?status=published` (what `onecli org policy rules list --status
    // published` sends) equals the dashboard's read now.
    const published = await call(
      "GET",
      "/v1/org/policy/rules?status=published",
    );
    expect(published.status).toBe(200);
    expect(
      (published.json as RuleDto[]).map((r) => [r.logicalId, r.name]),
    ).toEqual((await shown()).rules.map((r) => [r.logicalId, r.name]));
  });
});
