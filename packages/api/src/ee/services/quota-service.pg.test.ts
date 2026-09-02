import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Quotas are a billing concept: on a non-billing edition `getOrgLimits`
// returns UNLIMITED_LIMITS before it ever reads the org, so every limit here
// would be Infinity and the suite would assert nothing. CAPS is resolved at
// module load, so the edition must be pinned BEFORE the imports below — hence
// vi.hoisted. The onprem arm of that behavior is proven in the unit suite
// ("stays fully entitled on non-billing editions"); this file is the cloud
// proof, and it must hold in CI's onprem default lane too.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

import { proofDatabaseUrl } from "../../testing/pg-proof.js";
import { initEntitlementForTests } from "../../lib/entitlements";

/**
 * The per-org seat override on REAL PostgreSQL.
 *
 * The unit suite mocks `@onecli/db`, so it proves the arithmetic but NOT the
 * two things that actually break in production: that `max_members_override`
 * exists on the table, and that Prisma selects it into `getOrgLimits`. A
 * missing migration or a bad `@map` is green in the unit suite and a 500 in
 * prod. This drives real rows instead.
 *
 * Laws:
 *  - null override = the plan default (nothing changes for existing orgs);
 *  - a value replaces the plan limit in both directions;
 *  - seats counted = members + pending, unexpired invitations;
 *  - the override moves the seat cap only — the agent cap stays on its own
 *    column (the planted negative control: overriding seats must not widen
 *    agents).
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type Quotas = typeof import("./quota-service");

let db: Db;
let quotas: Quotas;

const P = "seat-";
const ORG_DEFAULT = `${P}org-default`;
const ORG_RAISED = `${P}org-raised`;
const ORG_TIGHTENED = `${P}org-tightened`;
const USER = `${P}user`;

const reset = async () => {
  await db.invitation.deleteMany({
    where: { organizationId: { startsWith: P } },
  });
  await db.organizationMember.deleteMany({
    where: { organizationId: { startsWith: P } },
  });
  await db.agent.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
};

/** N real member rows on an org — the thing seats are actually counted from. */
const seedMembers = async (organizationId: string, count: number) => {
  for (let i = 0; i < count; i += 1) {
    const userId = `${organizationId}-u${i}`;
    await db.user.create({
      data: {
        id: userId,
        email: `${userId}@example.com`,
        externalAuthId: userId,
      },
    });
    await db.organizationMember.create({
      data: {
        organizationId,
        userId,
        userEmail: `${userId}@example.com`,
        role: "member",
      },
    });
  }
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  initEntitlementForTests(true);
  ({ db } = await import("@onecli/db"));
  quotas = await import("./quota-service");
  await reset();

  await db.user.create({
    data: { id: USER, email: `${USER}@example.com`, externalAuthId: USER },
  });

  // Scale = 10 seats, 20 agents by plan.
  await db.organization.create({
    data: {
      id: ORG_DEFAULT,
      name: ORG_DEFAULT,
      slug: ORG_DEFAULT,
      subscriptionStatus: "scale",
    },
  });
  await db.organization.create({
    data: {
      id: ORG_RAISED,
      name: ORG_RAISED,
      slug: ORG_RAISED,
      subscriptionStatus: "scale",
      maxMembersOverride: 50,
    },
  });
  await db.organization.create({
    data: {
      id: ORG_TIGHTENED,
      name: ORG_TIGHTENED,
      slug: ORG_TIGHTENED,
      subscriptionStatus: "scale",
      maxMembersOverride: 2,
    },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  initEntitlementForTests(null);
});

describe.skipIf(!PROOF_URL)(
  "per-org seat override over real PostgreSQL",
  () => {
    it("persists and reads back the override column", async () => {
      const org = await db.organization.findUniqueOrThrow({
        where: { id: ORG_RAISED },
        select: { maxMembersOverride: true, maxAgentsOverride: true },
      });
      // Proves the migration landed and the @map matches the column.
      expect(org.maxMembersOverride).toBe(50);
      expect(org.maxAgentsOverride).toBeNull();
    });

    it("null override leaves the plan default untouched", async () => {
      const overview = await quotas.getUsageOverview(ORG_DEFAULT);
      const members = overview.resources.find((r) => r.name === "Members");
      expect(members?.limit).toBe(10); // scale's plan seat cap
      expect(overview.plan).toBe("scale");
    });

    it("an override raises the real invite gate past the plan limit", async () => {
      // 26 real member rows — over scale's 10, under the 50 override.
      await seedMembers(ORG_RAISED, 26);
      await expect(
        quotas.assertCanInviteMember(ORG_RAISED),
      ).resolves.toBeUndefined();

      const overview = await quotas.getUsageOverview(ORG_RAISED);
      const members = overview.resources.find((r) => r.name === "Members");
      expect(members).toEqual({ name: "Members", current: 26, limit: 50 });
    });

    it("counts a real pending invitation toward the overridden cap", async () => {
      await db.invitation.create({
        data: {
          organizationId: ORG_RAISED,
          email: `${P}invitee@example.com`,
          role: "member",
          token: `${P}token-pending`,
          invitedById: USER,
          invitedByEmail: `${USER}@example.com`,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const overview = await quotas.getUsageOverview(ORG_RAISED);
      const members = overview.resources.find((r) => r.name === "Members");
      expect(members?.current).toBe(27); // 26 members + 1 pending invite
    });

    it("ignores an expired invitation (it holds no seat)", async () => {
      await db.invitation.create({
        data: {
          organizationId: ORG_RAISED,
          email: `${P}stale@example.com`,
          role: "member",
          token: `${P}token-expired`,
          invitedById: USER,
          invitedByEmail: `${USER}@example.com`,
          expiresAt: new Date(Date.now() - 86_400_000),
        },
      });
      const overview = await quotas.getUsageOverview(ORG_RAISED);
      const members = overview.resources.find((r) => r.name === "Members");
      expect(members?.current).toBe(27); // unchanged
    });

    it("blocks the invite that would exceed the override", async () => {
      // 2 members against an override of 2.
      await seedMembers(ORG_TIGHTENED, 2);
      try {
        await quotas.assertCanInviteMember(ORG_TIGHTENED);
        expect.unreachable("should have thrown QuotaExceededError");
      } catch (err) {
        expect(err).toBeInstanceOf(quotas.QuotaExceededError);
        const quota = err as InstanceType<typeof quotas.QuotaExceededError>;
        expect(quota.resource).toBe("members");
        expect(quota.current).toBe(2);
        expect(quota.limit).toBe(2); // the override, below scale's 10
        expect(quota.plan).toBe("scale"); // the plan itself is unchanged
      }
    });

    it("does not widen the agent cap (negative control)", async () => {
      // ORG_RAISED has 50 seats but no agent override: agents stay on the
      // plan's 20, and the seat override must not leak across.
      await db.workspace.create({
        data: { id: `${P}proj`, name: `${P}proj`, organizationId: ORG_RAISED },
      });
      const overview = await quotas.getUsageOverview(ORG_RAISED);
      const byName = Object.fromEntries(
        overview.resources.map((r) => [r.name, r.limit]),
      );
      expect(byName["Agents"]).toBe(20); // scale's plan default
      expect(byName["Workspaces"]).toBe(Infinity);
    });
  },
);
