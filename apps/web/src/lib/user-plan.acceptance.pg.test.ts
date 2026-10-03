/**
 * ACCEPTANCE: the first-login onboarding gate, against real PostgreSQL.
 *
 * `checkDashboardRedirect` is what every dashboard page calls before it
 * renders, and it is the whole of this PR's first claim: a fresh org owner is
 * routed into `/onboarding` on EVERY edition, and only a paid org's owner is
 * exempt (billing editions only). Its unit tests hand-write a `db` mock whose
 * `user.findUnique` always returns a row and whose `organization.findUnique`
 * always returns `free` — so they assert the branch shape but never that the
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
  delete process.env.NEXT_PUBLIC_EDITION; // onprem: no billing
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
  "ACCEPTANCE: the first-login onboarding gate (onprem, real db)",
  () => {
    it("routes a fresh org OWNER into onboarding", async () => {
      // The PR's headline: self-hosted signups used to land on an empty
      // dashboard because the gate returned early without billing.
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

    it("never touches the subscription column without billing", async () => {
      // The read that must not run on a self-host (it reaches the Stripe
      // graph on cloud). Proven positively: the gate still routes correctly
      // for an org whose subscriptionStatus is a PAID value — which on a
      // billing edition would exempt this owner. Reading it here would flip
      // the answer to null, so the assertion is load-bearing.
      await db.organization.update({
        where: { id: ORG },
        data: { subscriptionStatus: "active" },
      });
      session.current = { id: OWNER, email: `${OWNER}@example.test` };

      expect(await checkDashboardRedirect()).toBe("/onboarding");

      await db.organization.update({
        where: { id: ORG },
        data: { subscriptionStatus: "free" },
      });
    });

    it("returns null rather than throwing when nobody is signed in", async () => {
      session.current = null;

      expect(await checkDashboardRedirect()).toBeNull();
    });
  },
);
