/**
 * ACCEPTANCE: the first-login onboarding gate, against real PostgreSQL.
 *
 * `checkDashboardRedirect` is what every dashboard page calls before it
 * renders. Onboarding is the billing editions' walkthrough: a fresh free-org
 * OWNER is routed into `/onboarding`, and a paid org's owner, a member, and a
 * completed owner are left alone (the onprem arm is a hard no-op, pinned by
 * `user-plan.onprem.test.ts`). Its unit tests hand-write a `db` mock whose
 * `user.findUnique` always returns a row and whose `organization.findUnique`
 * returns a canned status, so they assert the branch shape but never that the
 * real queries select the real columns, or that the roles the gate reasons
 * about are the roles the membership table actually stores.
 *
 * This suite mocks only the SESSION (there is no HTTP request here to carry
 * one). Every row, query and column is real.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Same gate as the api package's `pg-proof` helper, inlined because that
 * module does not resolve across the package boundary from the web app:
 * skip locally when no database is configured, fail loudly in CI so a
 * silently-vanishing suite can never report green.
 */
const proofDatabaseUrl = (): string | undefined => {
  const url = process.env.POLICY_PROOF_DATABASE_URL;
  if (url !== undefined && url !== "") return url;
  if (process.env.CI !== undefined && process.env.CI !== "") {
    throw new Error(
      "POLICY_PROOF_DATABASE_URL must be set in CI: the pg proof suites must not silently skip.",
    );
  }
  return undefined;
};

const PROOF_URL = proofDatabaseUrl();

const P = "onb-";
const ORG = `${P}org`;
const OWNER = `${P}owner`;
const MEMBER = `${P}member`;

// The two mocks, both request-scoped facts that only exist inside a real
// Next.js request: who is signed in, and the org the page is scoped to.
// Everything below them — every row, query, column and role — is real.
const session = vi.hoisted(() => ({
  current: null as { id: string; email: string } | null,
}));
vi.mock("@/lib/auth/server", () => ({
  getServerSession: async () => session.current,
}));

const requestHeaders = vi.hoisted(() => ({ orgId: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) =>
      name === "x-organization-id" ? requestHeaders.orgId : null,
  }),
}));

type Db = typeof import("@onecli/db").db;
let db: Db;
let checkDashboardRedirect: () => Promise<string | null>;

const seedUser = async (id: string, role: string) => {
  await db.user.create({
    data: { id, email: `${id}@example.test`, externalAuthId: id },
  });
  await db.organizationMember.create({
    data: {
      organizationId: ORG,
      userId: id,
      userEmail: `${id}@example.test`,
      role,
      status: "active",
    },
  });
};

const reset = async () => {
  await db.organizationMember.deleteMany({
    where: { organizationId: ORG },
  });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  // The billing edition: the only one onboarding routes on. Set before the
  // dynamic imports below, since CAPS resolves at module load.
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  // The auth module refuses to load without one; its value is irrelevant
  // here because the session itself is the mocked input.
  process.env.BETTER_AUTH_SECRET ??= "pg-proof-fake-secret-value-000000000000";

  ({ db } = await import("@onecli/db"));
  ({ checkDashboardRedirect } = await import("./user-plan"));

  await reset();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await seedUser(OWNER, "owner");
  await seedUser(MEMBER, "member");
});

beforeEach(async () => {
  if (!PROOF_URL) return;
  session.current = null;
  requestHeaders.orgId = ORG;
  await db.user.updateMany({
    where: { id: { startsWith: P } },
    data: { onboardingCompletedAt: null },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await reset();
  await db.$disconnect();
});

describe.skipIf(!PROOF_URL)(
  "ACCEPTANCE: the first-login onboarding gate (billing edition, real db)",
  () => {
    it("routes a fresh free-org OWNER into onboarding", async () => {
      session.current = { id: OWNER, email: `${OWNER}@example.test` };

      expect(await checkDashboardRedirect()).toBe("/onboarding");
    });

    it("leaves a MEMBER alone — onboarding is the creator's walkthrough", async () => {
      // An invited member joins a working org; bouncing them into a flow
      // that assumes they are setting one up would be wrong.
      session.current = { id: MEMBER, email: `${MEMBER}@example.test` };

      expect(await checkDashboardRedirect()).toBeNull();
    });

    it("leaves a COMPLETED owner alone — the walkthrough does not repeat", async () => {
      await db.user.update({
        where: { id: OWNER },
        data: { onboardingCompletedAt: new Date() },
      });
      session.current = { id: OWNER, email: `${OWNER}@example.test` };

      expect(await checkDashboardRedirect()).toBeNull();
    });

    it("leaves a PAID org's owner alone, read from the real subscription column", async () => {
      // Load-bearing on the real column: the same fresh owner the first case
      // routes into onboarding is exempt the moment their org is paid. A gate
      // that stopped reading subscription_status would still answer
      // "/onboarding" here.
      await db.organization.update({
        where: { id: ORG },
        data: { subscriptionStatus: "team" },
      });
      session.current = { id: OWNER, email: `${OWNER}@example.test` };

      try {
        expect(await checkDashboardRedirect()).toBeNull();
      } finally {
        await db.organization.update({
          where: { id: ORG },
          data: { subscriptionStatus: "free" },
        });
      }
    });

    it("returns null rather than throwing when nobody is signed in", async () => {
      session.current = null;

      expect(await checkDashboardRedirect()).toBeNull();
    });
  },
);
