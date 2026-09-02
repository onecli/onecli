import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Self-hosted-shaped, and the code under test reaches Prisma at module load —
// both pins have to be hoisted or the suite reads a different edition and a
// different database than it thinks (the invitation suite's exact trap).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  const proofUrl = process.env.POLICY_PROOF_DATABASE_URL;
  if (proofUrl) process.env.DATABASE_URL = proofUrl;
});

import { randomUUID } from "node:crypto";
import { db } from "@onecli/db";
import { proofDatabaseUrl } from "../../testing/pg-proof.js";
import { workspaceNameForOwner } from "../../services/organization-service";
import { initEntitlementForTests } from "../../lib/entitlements";
import {
  provisionUser,
  claimProvision,
  cancelProvision,
  cleanupExpiredProvisions,
} from "./user-provision-service";

/**
 * The provision-claim lifecycle, against real PostgreSQL.
 *
 * The unit suite proves which user id the claim binds; a mocked client can do
 * that honestly. What it cannot show is the half this suite exists for: the
 * claim transfers a live placeholder — membership, workspace, API key, access
 * binding — across real RESTRICT/CASCADE foreign keys, in one transaction,
 * and the teardown paths (cancel, expiry sweep) unwind the same graph without
 * stranding a row. This is pre-2.0 production data; "the placeholder died but
 * its API key survived pointing nowhere" is only visible to a database.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

const ADMIN_EMAIL = `admin-${randomUUID()}@example.invalid`;
const CLAIMER_EMAIL = `claimer-${randomUUID()}@example.invalid`;

interface Seeded {
  organizationId: string;
  adminId: string;
}

let seeded: Seeded | null = null;

const seed = async (): Promise<Seeded> => {
  const admin = await db.user.create({
    data: { email: ADMIN_EMAIL, externalAuthId: `ba:${randomUUID()}` },
  });
  const org = await db.organization.create({
    data: {
      name: "Acme",
      slug: `acme-${admin.id.slice(0, 8)}`,
      members: {
        create: { userId: admin.id, userEmail: ADMIN_EMAIL, role: "owner" },
      },
    },
  });
  return { organizationId: org.id, adminId: admin.id };
};

const mint = (s: Seeded, role = "member") =>
  provisionUser({
    organizationId: s.organizationId,
    role,
    provisionedById: s.adminId,
    provisionedByEmail: ADMIN_EMAIL,
    appUrl: "http://localhost:3000",
  });

const tokenOf = (claimUrl: string) =>
  new URL(claimUrl).searchParams.get("token")!;

const purge = async () => {
  const s = seeded;
  seeded = null;
  if (s) {
    // Collect every user the org touched (admin, placeholders, rebound
    // claimers) BEFORE tearing the org down — provision rows and memberships
    // are the only pointers to the placeholders.
    const provisions = await db.userProvision.findMany({
      where: { organizationId: s.organizationId },
      select: { userId: true },
    });
    const members = await db.organizationMember.findMany({
      where: { organizationId: s.organizationId },
      select: { userId: true },
    });
    const workspaces = await db.workspace.findMany({
      where: { organizationId: s.organizationId },
      select: { id: true },
    });
    const workspaceIds = workspaces.map((w) => w.id);
    const userIds = [
      ...new Set([
        s.adminId,
        ...provisions.map((p) => p.userId),
        ...members.map((m) => m.userId),
      ]),
    ];
    await db.apiKey.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await db.workspaceAccess.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.userProvision.deleteMany({
      where: { organizationId: s.organizationId },
    });
    await db.auditLog.deleteMany({
      where: { organizationId: s.organizationId },
    });
    await db.organizationMember.deleteMany({
      where: { organizationId: s.organizationId },
    });
    await db.organization.deleteMany({ where: { id: s.organizationId } });
    await db.onboardingSurvey.deleteMany({
      where: { userId: { in: userIds } },
    });
    await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  // Claimer users are created outside the org graph in some tests.
  await db.user.deleteMany({ where: { email: CLAIMER_EMAIL } });
};

describe.skipIf(!PROOF_URL)("provision claim over real PostgreSQL", () => {
  // Licensed features under test — run entitled; the unlicensed refusals are
  // proven in licensing/enterprise-lock.test.ts.
  beforeAll(() => initEntitlementForTests(true));
  afterAll(() => initEntitlementForTests(null));
  beforeAll(purge);
  afterEach(purge);

  it("mints a claimable placeholder: member + workspace + key + binding, atomically", async () => {
    seeded = await seed();
    const result = await mint(seeded);

    const provision = await db.userProvision.findUniqueOrThrow({
      where: { id: result.id },
    });
    expect(provision.status).toBe("pending");
    expect(provision.workspaceId).toBe(result.workspaceId);

    const membership = await db.organizationMember.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: seeded.organizationId,
          userId: result.userId,
        },
      },
    });
    expect(membership.role).toBe("member");

    const workspace = await db.workspace.findUniqueOrThrow({
      where: { id: result.workspaceId },
    });
    expect(workspace.createdByUserId).toBe(result.userId);

    const key = await db.apiKey.findFirstOrThrow({
      where: { workspaceId: result.workspaceId },
    });
    expect(key.key).toBe(result.apiKey);

    const binding = await db.workspaceAccess.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: result.workspaceId,
          userId: result.userId,
        },
      },
    });
    expect(binding.role).toBe("owner");
  });

  it("first-time claimer: the placeholder is rebound in place (Branch B)", async () => {
    seeded = await seed();
    const minted = await mint(seeded);
    const token = tokenOf(minted.claimUrl);

    // A user id that exists nowhere → the fresh-signup branch.
    const externalAuthId = `ba:${randomUUID()}`;
    const result = await claimProvision(
      token,
      randomUUID(),
      CLAIMER_EMAIL,
      externalAuthId,
    );
    expect(result.organizationId).toBe(seeded.organizationId);
    expect(result.organizationName).toBe("Acme");

    // The placeholder row now IS the claimer.
    const rebound = await db.user.findUniqueOrThrow({
      where: { id: minted.userId },
    });
    expect(rebound.email).toBe(CLAIMER_EMAIL);
    expect(rebound.externalAuthId).toBe(externalAuthId);

    const provision = await db.userProvision.findUniqueOrThrow({
      where: { id: minted.id },
    });
    expect(provision.status).toBe("claimed");
    expect(provision.claimedAt).not.toBeNull();

    const membership = await db.organizationMember.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: seeded.organizationId,
          userId: minted.userId,
        },
      },
    });
    expect(membership.userEmail).toBe(CLAIMER_EMAIL);

    // The deferred workspaceNameForOwner law: a fresh signup has no display
    // name at claim time, so the workspace takes their email (clamped by the
    // law itself — asserted through it, not around it).
    const workspace = await db.workspace.findUniqueOrThrow({
      where: { id: minted.workspaceId },
    });
    expect(workspace.name).toBe(workspaceNameForOwner(null, CLAIMER_EMAIL));
    expect(workspace.name).not.toBe("Default");
  });

  it("existing-account claimer: everything transfers, the placeholder dies (Branch A)", async () => {
    seeded = await seed();
    const minted = await mint(seeded);
    const token = tokenOf(minted.claimUrl);

    const claimer = await db.user.create({
      data: {
        email: CLAIMER_EMAIL,
        name: "Casey Claimer",
        externalAuthId: `ba:${randomUUID()}`,
      },
    });

    const result = await claimProvision(
      token,
      claimer.id,
      CLAIMER_EMAIL,
      claimer.externalAuthId!,
    );
    expect(result.organizationId).toBe(seeded.organizationId);

    // Membership repointed to the real account; the placeholder is gone —
    // with every RESTRICT child accounted for, or the delete would have blown.
    const membership = await db.organizationMember.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: seeded.organizationId,
          userId: claimer.id,
        },
      },
    });
    expect(membership.userEmail).toBe(CLAIMER_EMAIL);
    expect(
      await db.user.findUnique({ where: { id: minted.userId } }),
    ).toBeNull();

    // The pre-minted API key and workspace now belong to the claimer.
    const key = await db.apiKey.findFirstOrThrow({
      where: { workspaceId: minted.workspaceId },
    });
    expect(key.userId).toBe(claimer.id);
    const binding = await db.workspaceAccess.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: minted.workspaceId,
          userId: claimer.id,
        },
      },
    });
    expect(binding.role).toBe("owner");

    // The deferred workspaceNameForOwner law: the claimer has a display
    // name, so the workspace sheds its minted "Default" for it.
    const workspace = await db.workspace.findUniqueOrThrow({
      where: { id: minted.workspaceId },
    });
    expect(workspace.name).toBe("Casey Claimer");

    // The provision row is deleted in this branch, so the link is dead.
    expect(
      await db.userProvision.findUnique({ where: { id: minted.id } }),
    ).toBeNull();
  });

  it("a claimed link cannot be replayed", async () => {
    seeded = await seed();
    const minted = await mint(seeded);
    const token = tokenOf(minted.claimUrl);

    await claimProvision(
      token,
      randomUUID(),
      CLAIMER_EMAIL,
      `ba:${randomUUID()}`,
    );

    await expect(
      claimProvision(
        token,
        randomUUID(),
        `again-${CLAIMER_EMAIL}`,
        `ba:${randomUUID()}`,
      ),
    ).rejects.toThrow("already been claimed");
  });

  it("cancel unwinds the whole placeholder graph", async () => {
    seeded = await seed();
    const minted = await mint(seeded);

    await cancelProvision(seeded.organizationId, minted.id);

    expect(
      await db.userProvision.findUnique({ where: { id: minted.id } }),
    ).toBeNull();
    expect(
      await db.workspace.findUnique({ where: { id: minted.workspaceId } }),
    ).toBeNull();
    expect(
      await db.user.findUnique({ where: { id: minted.userId } }),
    ).toBeNull();
    expect(
      await db.organizationMember.findFirst({
        where: { userId: minted.userId },
      }),
    ).toBeNull();
  });

  it("the expiry sweep reaps dead placeholders and their claim links", async () => {
    seeded = await seed();
    const minted = await mint(seeded);
    const token = tokenOf(minted.claimUrl);
    await db.userProvision.update({
      where: { id: minted.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await cleanupExpiredProvisions(seeded.organizationId);

    expect(
      await db.userProvision.findUnique({ where: { id: minted.id } }),
    ).toBeNull();
    expect(
      await db.user.findUnique({ where: { id: minted.userId } }),
    ).toBeNull();

    // And the swept link is dead for a would-be claimer.
    await expect(
      claimProvision(token, randomUUID(), CLAIMER_EMAIL, `ba:${randomUUID()}`),
    ).rejects.toThrow("Invalid claim link");
  });

  it("concurrent duplicate claims: exactly one wins, the account belongs to the winner", async () => {
    seeded = await seed();
    const minted = await mint(seeded);
    const token = tokenOf(minted.claimUrl);

    // Two fresh signups race the same link (a claim URL pasted into a team
    // channel). Without the CAS replay guard both transactions pass the
    // status re-check and the loser silently overwrites the winner's
    // identity on the rebound placeholder.
    const identities = [0, 1].map((i) => ({
      email: `racer-${i}-${CLAIMER_EMAIL}`,
      authId: `ba:${randomUUID()}`,
    }));
    const outcomes = await Promise.allSettled(
      identities.map((who) =>
        claimProvision(token, randomUUID(), who.email, who.authId),
      ),
    );

    const winners = outcomes.filter((o) => o.status === "fulfilled");
    const losers = outcomes.filter((o) => o.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // The rebound placeholder carries exactly the winner's identity.
    const winnerIdx = outcomes.findIndex((o) => o.status === "fulfilled");
    const rebound = await db.user.findUniqueOrThrow({
      where: { id: minted.userId },
    });
    expect(rebound.email).toBe(identities[winnerIdx]!.email);
    expect(rebound.externalAuthId).toBe(identities[winnerIdx]!.authId);
    // No extra cleanup: the winner IS the rebound placeholder, an org member
    // the suite's purge already tears down in FK order; the loser never
    // committed a row.
  });

  it("an expired-flip claim attempt is reaped by the next sweep, freeing the seat", async () => {
    seeded = await seed();
    const minted = await mint(seeded);
    const token = tokenOf(minted.claimUrl);
    await db.userProvision.update({
      where: { id: minted.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // A claim attempt on an overdue link flips the row to "expired" with a
    // readable error…
    await expect(
      claimProvision(token, randomUUID(), CLAIMER_EMAIL, `ba:${randomUUID()}`),
    ).rejects.toThrow("expired");
    const flipped = await db.userProvision.findUniqueOrThrow({
      where: { id: minted.id },
    });
    expect(flipped.status).toBe("expired");

    // …and the sweep still reaps it — a stranded "expired" row would hold a
    // seat, a workspace and a live API key forever.
    await cleanupExpiredProvisions(seeded.organizationId);
    expect(
      await db.userProvision.findUnique({ where: { id: minted.id } }),
    ).toBeNull();
    expect(
      await db.user.findUnique({ where: { id: minted.userId } }),
    ).toBeNull();
    expect(
      await db.workspace.findUnique({ where: { id: minted.workspaceId } }),
    ).toBeNull();
  });

  it("a deleted pre-minted workspace cannot wedge the provision: claim refuses readably, the sweep still reaps", async () => {
    seeded = await seed();
    const minted = await mint(seeded);
    const token = tokenOf(minted.claimUrl);

    // An org admin deletes the placeholder's workspace through the normal
    // workspace-delete path (workspaceId deliberately has no FK).
    await db.apiKey.deleteMany({ where: { workspaceId: minted.workspaceId } });
    await db.workspaceAccess.deleteMany({
      where: { workspaceId: minted.workspaceId },
    });
    await db.workspace.delete({ where: { id: minted.workspaceId } });

    // Claim refuses with an answer, not a P2025 mid-transfer explosion.
    await expect(
      claimProvision(token, randomUUID(), CLAIMER_EMAIL, `ba:${randomUUID()}`),
    ).rejects.toThrow("no longer available");

    // And once expired, the sweep reaps the leftovers instead of wedging on
    // the missing workspace (which would block every later sweep in the org).
    await db.userProvision.update({
      where: { id: minted.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await cleanupExpiredProvisions(seeded.organizationId);
    expect(
      await db.userProvision.findUnique({ where: { id: minted.id } }),
    ).toBeNull();
    expect(
      await db.user.findUnique({ where: { id: minted.userId } }),
    ).toBeNull();
  });
});
