import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The AWS external ID on REAL PostgreSQL, driven through the REAL HTTP
 * surface — the committed proof for the two properties the mocked suites can
 * only assert against a hand-rolled store:
 *
 *   1. The connect endpoint stores the CALLER'S OWN org external id, even when
 *      the request body carries a different one. A forged value must not reach
 *      the credentials the gateway later hands to sts:AssumeRole.
 *   2. Minting is idempotent AT THE DATABASE, under real concurrency. The id
 *      is what the customer pinned in their IAM trust policy, so a second
 *      write that changes it would break every existing connection in the org.
 *
 * Both are "which value actually lands in which row" questions, which is
 * exactly the class a mock cannot answer: the mock is my own model of Prisma,
 * so it proves my model, not the behavior. The conditional-write race in
 * particular depends on real `updateMany` semantics against a real unique row.
 *
 * Env-gated like the other proof suites: skipped unless
 * POLICY_PROOF_DATABASE_URL points at a migrated PostgreSQL, e.g.
 *
 *   docker run -d --name awsid-proof-pg -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=onecli -p 5447:5432 postgres:18-alpine
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5447/onecli" \
 *     pnpm --filter @onecli/db exec prisma migrate deploy
 *   POLICY_PROOF_DATABASE_URL="postgresql://postgres:postgres@localhost:5447/onecli" \
 *     pnpm --filter @onecli/api test -- --run src/routes/aws-external-id.pg.test.ts
 */

const PROOF_URL = proofDatabaseUrl();

// Dynamic imports: @onecli/db builds its client from DATABASE_URL at import
// time, so the env must be staged before anything pulls it in.
type Db = typeof import("@onecli/db").db;

let db: Db;
let app: Awaited<ReturnType<typeof import("../app.js").createApiApp>>;
let ensureOrgAwsExternalId: (organizationId: string) => Promise<string>;

const P = "awsidproof-";
const ORG = `${P}org`;
const OTHER_ORG = `${P}other-org`;
const WORKSPACE = `${P}ws`;
const USER = `${P}user`;
const OTHER_USER = `${P}other-user`;
const KEY = `oc_org_${P}key`;
const WORKSPACE_KEY = `oc_${P}ws-key`;
const OTHER_KEY = `oc_org_${P}other-key`;

/** What the gateway reads off the connection to sign an AssumeRole call. */
const storedExternalId = async (provider: string): Promise<string> => {
  const conn = await db.appConnection.findFirst({
    where: { organizationId: ORG, provider },
    select: { credentials: true },
  });
  if (!conn?.credentials) throw new Error("no connection stored");
  // Read it back the way the credential-resolution path does, through the
  // edition's own crypto service — so this asserts on the real stored bytes.
  const { getCrypto } = await import("../providers/index.js");
  const plaintext = await getCrypto().decrypt(conn.credentials);
  return (JSON.parse(plaintext) as { externalId: string }).externalId;
};

describe.skipIf(!PROOF_URL)("AWS external id (real PostgreSQL)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = PROOF_URL;
    process.env.NEXT_PUBLIC_EDITION = "onprem";
    // A real 32-byte AES key: the connect path encrypts credentials for real
    // here, so the crypto provider must actually accept it.
    process.env.SECRET_ENCRYPTION_KEY =
      "7eeHVTcHkPw4rfI6wb0LSZje0mKDphzuz8QLocq0Egw=";
    process.env.OAUTH_STATE_SECRET = "proof-oauth-state-secret";

    ({ db } = await import("@onecli/db"));
    const { createApiApp } = await import("../app.js");
    const { initRoleResolver } = await import("../providers/index.js");
    const { getUserRole } =
      await import("../ee/services/authorization-service.js");
    // The browser reaches this endpoint by SESSION, where the ROLE GATE (not
    // key authentication) is what refuses a non-admin — a different code path
    // from the org-key tests, so it needs its own coverage.
    initRoleResolver({ getUserRole });
    ({ ensureOrgAwsExternalId } =
      await import("../services/aws-external-id-service.js"));

    // A session provider driven by a header the test controls, so a request
    // can act as any user without minting real Cognito/better-auth tokens.
    app = createApiApp({
      getSession: async (request: Request) => {
        const who = request.headers.get("x-test-user");
        return who ? { id: `${who}-auth`, email: `${who}@example.com` } : null;
      },
    });
  });

  beforeEach(async () => {
    // Clean slate, children first.
    await db.appConnection.deleteMany({
      where: { organizationId: { in: [ORG, OTHER_ORG] } },
    });
    await db.apiKey.deleteMany({
      where: { key: { in: [KEY, OTHER_KEY, WORKSPACE_KEY] } },
    });
    await db.workspace.deleteMany({ where: { id: WORKSPACE } });
    await db.organizationMember.deleteMany({
      where: { organizationId: { in: [ORG, OTHER_ORG] } },
    });
    await db.user.deleteMany({ where: { id: { in: [USER, OTHER_USER] } } });
    await db.organization.deleteMany({
      where: { id: { in: [ORG, OTHER_ORG] } },
    });

    for (const [id, slug] of [
      [ORG, `${P}org-slug`],
      [OTHER_ORG, `${P}other-slug`],
    ] as const) {
      await db.organization.create({ data: { id, name: id, slug } });
    }
    for (const [id, email] of [
      [USER, `${P}u@example.com`],
      [OTHER_USER, `${P}o@example.com`],
    ] as const) {
      await db.user.create({
        data: { id, email, externalAuthId: `${id}-auth` },
      });
    }
    await db.organizationMember.create({
      data: {
        organizationId: ORG,
        userId: USER,
        userEmail: `${P}u@example.com`,
        role: "owner",
      },
    });
    await db.organizationMember.create({
      data: {
        organizationId: OTHER_ORG,
        userId: OTHER_USER,
        userEmail: `${P}o@example.com`,
        role: "owner",
      },
    });
    await db.workspace.create({
      data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
    });
    await db.apiKey.create({
      data: {
        key: KEY,
        name: "proof",
        userId: USER,
        userEmail: `${P}u@example.com`,
        organizationId: ORG,
        scope: "organization",
      },
    });
    await db.apiKey.create({
      data: {
        key: WORKSPACE_KEY,
        name: "proof-workspace",
        userId: USER,
        userEmail: `${P}u@example.com`,
        workspaceId: WORKSPACE,
        scope: "workspace",
      },
    });
    await db.apiKey.create({
      data: {
        key: OTHER_KEY,
        name: "proof-other",
        userId: OTHER_USER,
        userEmail: `${P}o@example.com`,
        organizationId: OTHER_ORG,
        scope: "organization",
      },
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const headers = (key = KEY) => ({
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  });

  it("serves an id over HTTP and persists it to the org row", async () => {
    const res = await app.request("/v1/org/apps/aws-external-id", {
      headers: headers(),
    });

    expect(res.status).toBe(200);
    const { externalId } = (await res.json()) as { externalId: string };
    expect(externalId).toMatch(/^onecli-[0-9a-f-]{36}$/);

    const row = await db.organization.findUnique({
      where: { id: ORG },
      select: { awsExternalId: true },
    });
    expect(row?.awsExternalId).toBe(externalId);
  });

  it("returns the same id across requests (a pinned trust policy stays valid)", async () => {
    const first = await app.request("/v1/org/apps/aws-external-id", {
      headers: headers(),
    });
    const second = await app.request("/v1/org/apps/aws-external-id", {
      headers: headers(),
    });

    const a = (await first.json()) as { externalId: string };
    const b = (await second.json()) as { externalId: string };
    expect(b.externalId).toBe(a.externalId);
  });

  it("never returns another org's id", async () => {
    const mine = (await (
      await app.request("/v1/org/apps/aws-external-id", { headers: headers() })
    ).json()) as { externalId: string };
    const theirs = (await (
      await app.request("/v1/org/apps/aws-external-id", {
        headers: headers(OTHER_KEY),
      })
    ).json()) as { externalId: string };

    expect(theirs.externalId).not.toBe(mine.externalId);
  });

  it("survives concurrent first reads with ONE id (real row, real race)", async () => {
    // Eight simultaneous first-reads against an unset column. Every caller must
    // come back with the same value, and the row must hold that value — an
    // overwrite here would silently invalidate a customer's trust policy.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureOrgAwsExternalId(ORG)),
    );

    expect(new Set(results).size).toBe(1);
    const row = await db.organization.findUnique({
      where: { id: ORG },
      select: { awsExternalId: true },
    });
    expect(row?.awsExternalId).toBe(results[0]);
  });

  it("resolves the org from a WORKSPACE-scoped request (the reported bug)", async () => {
    // The exact shape of the popup in the bug report: opened from
    // /w/<id>/connections, so the request names a WORKSPACE and no org at all.
    // This is what used to leave the field blank — there was no orgId in the
    // URL, so nothing was ever fetched. The org must now be derived from the
    // workspace server-side.
    const res = await app.request("/v1/org/apps/aws-external-id", {
      headers: {
        authorization: `Bearer ${WORKSPACE_KEY}`,
        "x-workspace-id": WORKSPACE,
        "content-type": "application/json",
      },
    });

    expect(res.status).toBe(200);
    const { externalId } = (await res.json()) as { externalId: string };
    expect(externalId).toBe(await ensureOrgAwsExternalId(ORG));
  });

  it("RBAC: a plain MEMBER on a session is refused (the browser's path)", async () => {
    // The org-key test proves the key itself dies at authentication. This is
    // the other door: a real session whose user holds `member`, refused by the
    // ROLE GATE.
    //
    // This suite pins the onprem edition (flat team, CAPS.rbac off), where the
    // gate is a no-op by design — so an `if (!CAPS.rbac) return` here would
    // make the case silently vanish, which is exactly the "green means
    // nothing" trap pg-proof.ts exists to prevent. Flip the capability for
    // this one assertion instead, so the gate is genuinely exercised.
    const env = await import("../lib/env.js");
    const original = env.CAPS.rbac;
    Object.defineProperty(env.CAPS, "rbac", {
      value: true,
      configurable: true,
    });
    try {
      await db.organizationMember.update({
        where: {
          organizationId_userId: { organizationId: ORG, userId: USER },
        },
        data: { role: "member" },
      });

      const res = await app.request("/v1/org/apps/aws-external-id", {
        headers: { "x-test-user": USER, "x-organization-id": ORG },
      });

      expect(res.status).toBe(403);
      // And the refusal happened BEFORE any mint: a member must not be able to
      // create org state as a side effect of being refused.
      const row = await db.organization.findUnique({
        where: { id: ORG },
        select: { awsExternalId: true },
      });
      expect(row?.awsExternalId).toBeNull();
    } finally {
      Object.defineProperty(env.CAPS, "rbac", {
        value: original,
        configurable: true,
      });
    }
  });

  it("a SUSPENDED admin can no longer read the org id", async () => {
    // Deprovisioning must actually cut access: a suspended member reads as a
    // non-member everywhere, so the org-scoped identity goes with it.
    await db.organizationMember.update({
      where: {
        organizationId_userId: { organizationId: ORG, userId: USER },
      },
      data: { status: "suspended" },
    });

    const res = await app.request("/v1/org/apps/aws-external-id", {
      headers: { "x-test-user": USER, "x-organization-id": ORG },
    });

    expect(res.status).not.toBe(200);
  });

  it("connect stores OUR external id, discarding the one in the body", async () => {
    // THE acceptance property. A caller in ORG posts OTHER_ORG's external id;
    // what must land in the stored credentials — the value the gateway signs
    // AssumeRole with — is ORG's own.
    const foreign = await ensureOrgAwsExternalId(OTHER_ORG);

    const res = await app.request("/v1/org/apps/aws-role/connect", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        fields: {
          roleArn: "arn:aws:iam::123456789012:role/OneCLI-Agent-Role",
          region: "us-east-1",
          externalId: foreign,
        },
      }),
    });

    expect(res.status).toBe(200);

    const stored = await storedExternalId("aws-role");
    const ours = await ensureOrgAwsExternalId(ORG);
    expect(stored).toBe(ours);
    expect(stored).not.toBe(foreign);
  });

  it("never stores an aws-role connection without an external id", async () => {
    // Why this matters beyond the API: the gateway's AssumeRole finalizer
    // defaults a MISSING x-onecli-aws-external-id header to "" and signs
    // anyway (aws_sts.rs), and the header is only injected when the stored
    // credential actually carries the field. So "no stored externalId" would
    // mean "AssumeRole with no external id" — the confused-deputy protection
    // silently absent.
    //
    // That gateway fallback is pre-existing and out of this change's scope
    // (no gateway files are touched here). This asserts the API-side half:
    // the row it would need can never be created. If a future change makes
    // the guard reachable, this fails first.
    // Client-supplied emptiness is not the interesting case — `serverFields`
    // overwrites it either way. The reachable one is an UNRESOLVABLE ORG:
    // ensureOrgAwsExternalId returns "" for an org row that isn't there, and
    // without the app's own guard that empty value would be stored and then
    // signed with. Simulate it by deleting the org's row mid-flight, keeping
    // the api key (and so the auth context) valid.
    const { resolveConnectCredentials } =
      await import("../apps/connect-credentials.js");
    const { getApp } = await import("../apps/registry.js");
    const appDef = getApp("aws-role")!;

    const resolved = await resolveConnectCredentials(
      "aws-role",
      appDef,
      {
        fields: {
          roleArn: "arn:aws:iam::123456789012:role/R",
          region: "us-east-1",
        },
      },
      // An organization id with no row behind it.
      `${P}ghost-org`,
    ).catch((e: Error) => e);

    // It must NOT come back ok with an empty external id.
    if (!(resolved instanceof Error)) {
      expect(resolved.ok).toBe(false);
    }

    // And the happy path still stores a real, non-empty id.
    const ok = await app.request("/v1/org/apps/aws-role/connect", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        fields: {
          roleArn: "arn:aws:iam::123456789012:role/R",
          region: "us-east-1",
        },
      }),
    });
    expect(ok.status).toBe(200);

    const { getCrypto } = await import("../providers/index.js");
    const conns = await db.appConnection.findMany({
      where: { organizationId: ORG, provider: "aws-role" },
      select: { credentials: true },
    });
    expect(conns.length).toBeGreaterThan(0);
    for (const c of conns) {
      const creds = JSON.parse(await getCrypto().decrypt(c.credentials!)) as {
        externalId?: string;
      };
      expect(creds.externalId).toBeTruthy();
    }
  });

  it("connect succeeds with NO externalId in the body at all", async () => {
    // The user-visible half of the original bug: the field is no longer a form
    // input, so a connect that never mentions it must still work.
    const res = await app.request("/v1/org/apps/aws-role/connect", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        fields: {
          roleArn: "arn:aws:iam::123456789012:role/OneCLI-Agent-Role",
          region: "us-east-1",
        },
      }),
    });

    expect(res.status).toBe(200);
    const stored = await storedExternalId("aws-role");
    expect(stored).toBe(await ensureOrgAwsExternalId(ORG));
  });
});
