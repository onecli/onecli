import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * Deleting an account over the REAL HTTP surface against REAL PostgreSQL.
 *
 * The mocked suites prove the plan and the ordering. What only real rows can
 * prove is the foreign-key path: `users` has RESTRICT children (`api_keys`,
 * `audit_logs`, `invitations.invited_by_id`, `user_provisions`), and the whole
 * point of the feature is to make `DELETE /v1/user` reachable for a user who
 * used the product — an admin who sent an invitation, say — not just for a
 * pristine row. A teardown that forgets one of those children looks perfect
 * in a mock and dies on the constraint in production.
 *
 * Env-gated like the other proof suites: skipped unless
 * POLICY_PROOF_DATABASE_URL points at a migrated PostgreSQL, e.g.
 *
 *   docker run -d --name acct-proof-pg -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=onecli -p 5441:5432 postgres:18-alpine
 *   DATABASE_URL="postgresql://postgres:postgres@localhost:5441/onecli" \
 *     pnpm --filter @onecli/db exec prisma migrate deploy
 *   POLICY_PROOF_DATABASE_URL="postgresql://postgres:postgres@localhost:5441/onecli" \
 *     pnpm --filter @onecli/api test -- --run src/routes/user-deletion.pg.test.ts
 */

const PROOF_URL = proofDatabaseUrl();

// Dynamic imports: @onecli/db builds its client from DATABASE_URL at import
// time, so the env must be staged before anything pulls it in.
type Db = typeof import("@onecli/db").db;

let db: Db;
let app: Awaited<ReturnType<typeof import("../app.js").createApiApp>>;
let createInvitation: typeof import("../services/invitation-service.js").createInvitation;
let bootstrapOrganization: typeof import("../services/organization-service.js").bootstrapOrganization;

const P = "acctproof-";
const LEAVER = `${P}leaver`;
const OWNER = `${P}owner`;
const SHARED_ORG = `${P}shared`;
const email = (who: string) => `${who}@example.com`;

const as = (who: string) => ({ headers: { "x-test-user": who } });

describe.skipIf(!PROOF_URL)("DELETE /v1/user (real PostgreSQL)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = PROOF_URL;
    process.env.NEXT_PUBLIC_EDITION = "onprem";
    process.env.SECRET_ENCRYPTION_KEY =
      "7eeHVTcHkPw4rfI6wb0LSZje0mKDphzuz8QLocq0Egw=";
    process.env.OAUTH_STATE_SECRET = "proof-oauth-state-secret";

    ({ db } = await import("@onecli/db"));
    const { createApiApp } = await import("../app.js");
    ({ createInvitation } = await import("../services/invitation-service.js"));
    ({ bootstrapOrganization } =
      await import("../services/organization-service.js"));

    // A session provider driven by a header the test controls (the
    // invitation proof's precedent): the id is the externalAuthId, exactly
    // what the real provider hands the route.
    app = createApiApp({
      getSession: async (request: Request) => {
        const who = request.headers.get("x-test-user");
        return who ? { id: `${who}-auth`, email: email(who) } : null;
      },
    });
  });

  /** Everything either fixture user can have touched, in FK order. */
  const purge = async () => {
    const users = await db.user.findMany({
      where: { id: { startsWith: P } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    const orgs = await db.organization.findMany({
      where: {
        OR: [
          { id: SHARED_ORG },
          { members: { some: { userId: { in: userIds } } } },
        ],
      },
      select: { id: true },
    });
    const orgIds = orgs.map((o) => o.id);
    const workspaces = await db.workspace.findMany({
      where: { organizationId: { in: orgIds } },
      select: { id: true },
    });
    const workspaceIds = workspaces.map((w) => w.id);
    await db.agent.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await db.apiKey.deleteMany({
      where: {
        OR: [
          { workspaceId: { in: workspaceIds } },
          { organizationId: { in: orgIds } },
          { userId: { in: userIds } },
        ],
      },
    });
    await db.policyRuleV2.deleteMany({
      where: {
        OR: [
          { workspaceId: { in: workspaceIds } },
          { organizationId: { in: orgIds } },
        ],
      },
    });
    await db.workspaceAccess.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.invitation.deleteMany({
      where: {
        OR: [
          { organizationId: { in: orgIds } },
          { invitedById: { in: userIds } },
        ],
      },
    });
    await db.auditLog.deleteMany({
      where: {
        OR: [{ organizationId: { in: orgIds } }, { userId: { in: userIds } }],
      },
    });
    await db.organizationMember.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  };

  beforeEach(async () => {
    await purge();
    for (const who of [LEAVER, OWNER]) {
      await db.user.create({
        data: { id: who, email: email(who), externalAuthId: `${who}-auth` },
      });
    }
    // A shared org the OWNER owns, where the LEAVER is an admin who did
    // real work: sent an invitation (invited_by_id → users, RESTRICT).
    await db.organization.create({
      data: { id: SHARED_ORG, name: "Shared", slug: SHARED_ORG },
    });
    await db.organizationMember.createMany({
      data: [
        {
          organizationId: SHARED_ORG,
          userId: OWNER,
          userEmail: email(OWNER),
          role: "owner",
        },
        {
          organizationId: SHARED_ORG,
          userId: LEAVER,
          userEmail: email(LEAVER),
          role: "admin",
        },
      ],
    });
    await createInvitation({
      organizationId: SHARED_ORG,
      email: `${P}newcomer@example.com`,
      role: "member",
      invitedById: LEAVER,
      invitedByEmail: email(LEAVER),
    });
  });

  afterAll(async () => {
    await purge();
    await db.$disconnect();
  });

  it("deletes a user who owns a solo org, left a shared org, and sent an invitation there", async () => {
    // The self-host default: the leaver also owns a personal org with a
    // default workspace and an API key (api_keys.user_id → users, RESTRICT).
    const { organization: solo } = await bootstrapOrganization(
      LEAVER,
      email(LEAVER),
      "Solo",
    );

    const impact = await app.request("/v1/user/deletion-impact", as(LEAVER));
    expect(impact.status).toBe(200);
    const { organizations } = (await impact.json()) as {
      organizations: { organizationId: string; outcome: string }[];
    };
    expect(
      organizations.map((o) => [o.organizationId, o.outcome]).sort(),
    ).toEqual(
      [
        [SHARED_ORG, "leave"],
        [solo.id, "delete"],
      ].sort(),
    );

    const res = await app.request("/v1/user", {
      method: "DELETE",
      ...as(LEAVER),
    });
    expect(res.status).toBe(204);

    // The person is gone; so is their solo org; the shared org lives on
    // with its owner and the open invitation, now attributed to that owner.
    expect(await db.user.findUnique({ where: { id: LEAVER } })).toBeNull();
    expect(
      await db.organization.findUnique({ where: { id: solo.id } }),
    ).toBeNull();
    expect(
      await db.organizationMember.findMany({
        where: { organizationId: SHARED_ORG },
        select: { userId: true },
      }),
    ).toEqual([{ userId: OWNER }]);
    const invitations = await db.invitation.findMany({
      where: { organizationId: SHARED_ORG },
      select: { invitedById: true, invitedByEmail: true, status: true },
    });
    expect(invitations).toEqual([
      { invitedById: OWNER, invitedByEmail: email(LEAVER), status: "pending" },
    ]);

    // And the session behind the deleted row no longer resolves.
    const after = await app.request("/v1/user/deletion-impact", as(LEAVER));
    expect(after.status).toBe(401);
  });

  it("refuses with 409 while the user owns an org with other members, changing nothing", async () => {
    // Flip roles: the LEAVER owns the shared org, the OWNER is a mere member.
    await db.organizationMember.update({
      where: {
        organizationId_userId: { organizationId: SHARED_ORG, userId: OWNER },
      },
      data: { role: "member" },
    });
    await db.organizationMember.update({
      where: {
        organizationId_userId: { organizationId: SHARED_ORG, userId: LEAVER },
      },
      data: { role: "owner" },
    });

    const res = await app.request("/v1/user", {
      method: "DELETE",
      ...as(LEAVER),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { message: expect.stringContaining('"Shared"') },
    });
    expect(await db.user.findUnique({ where: { id: LEAVER } })).not.toBeNull();
    expect(
      await db.organizationMember.count({
        where: { organizationId: SHARED_ORG },
      }),
    ).toBe(2);
  });

  it("deletes a user who belongs to no organization at all", async () => {
    // The dead end the feature exists for: strip every membership and the
    // authored row, leaving a bare user that the org-scoped auth cannot even
    // resolve.
    await db.invitation.deleteMany({ where: { invitedById: LEAVER } });
    await db.organizationMember.deleteMany({ where: { userId: LEAVER } });

    const res = await app.request("/v1/user", {
      method: "DELETE",
      ...as(LEAVER),
    });
    expect(res.status).toBe(204);
    expect(await db.user.findUnique({ where: { id: LEAVER } })).toBeNull();
  });
});
