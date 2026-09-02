import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * `ensureUserOrganization` on REAL PostgreSQL — the first-registration
 * bootstrap's concurrency and atomicity laws, none of which a mocked client
 * can tell the truth about (advisory locks, unique constraints, nested-write
 * atomicity, READ COMMITTED visibility).
 *
 * Laws pinned here:
 *  - a call that loses the per-user advisory lock BLOCKS and then converges on
 *    the winner's rows (the pre-fix behavior was a P2002 on the deterministic
 *    org slug → a 500 on first registration);
 *  - the crashed-bootstrap partial state (owner membership whose org has zero
 *    workspaces) is repaired in place — pre-fix it wedged every session sync;
 *  - any other membership-without-workspace shape falls through to a fresh
 *    personal org (today's behavior, no new grants inside admin-managed orgs);
 *  - a slug collision against a writer that does NOT take the lock still
 *    rethrows when there is nothing to converge on (the EE duplicate-name 409
 *    depends on P2002 escaping).
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type OrgService = typeof import("./organization-service");

let db: Db;
let svc: OrgService;

const P = "orgboot-";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let userSeq = 0;
/** A P-keyed user row; everything else this suite creates hangs off one. */
const makeUser = async (label: string) => {
  userSeq += 1;
  const id = `${P}${label}-${userSeq}`;
  const email = `${id}@example.invalid`;
  await db.user.create({
    data: {
      id,
      email,
      externalAuthId: `${P}ext-${label}-${userSeq}`,
      name: null,
    },
  });
  return { id, email };
};

/** Reap everything reachable from this suite's P-keyed users. */
const reset = async () => {
  const users = await db.user.findMany({
    where: { id: { startsWith: P } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  const memberships =
    userIds.length === 0
      ? []
      : await db.organizationMember.findMany({
          where: { userId: { in: userIds } },
          select: { organizationId: true },
        });
  // Orgs reachable through a membership PLUS directly-planted P-keyed ones —
  // the collision squatter has no members, so the join alone would miss it.
  const planted = await db.organization.findMany({
    where: { OR: [{ id: { startsWith: P } }, { slug: { startsWith: P } }] },
    select: { id: true },
  });
  const orgIds = [
    ...new Set([
      ...memberships.map((m) => m.organizationId),
      ...planted.map((o) => o.id),
    ]),
  ];
  if (userIds.length === 0 && orgIds.length === 0) return;
  await db.organizationMember.deleteMany({
    where: { userId: { in: userIds } },
  });
  if (orgIds.length > 0) {
    await db.apiKey.deleteMany({
      where: { workspace: { organizationId: { in: orgIds } } },
    });
    await db.workspaceAccess.deleteMany({
      where: { workspace: { organizationId: { in: orgIds } } },
    });
    await db.policyRuleV2.deleteMany({
      where: { workspace: { organizationId: { in: orgIds } } },
    });
    await db.workspace.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
  }
  if (userIds.length > 0)
    await db.user.deleteMany({ where: { id: { in: userIds } } });
};

describe.skipIf(!PROOF_URL)(
  "ensureUserOrganization over real PostgreSQL",
  () => {
    beforeAll(async () => {
      process.env.DATABASE_URL = PROOF_URL;
      ({ db } = await import("@onecli/db"));
      // The server does this at boot; the bootstrap's policy seeder resolves
      // through the provider registry it fills.
      const { ensureEditionDefaults } = await import("../edition-defaults");
      ensureEditionDefaults();
      svc = await import("./organization-service");
      await reset();
    });

    afterEach(reset);
    afterAll(async () => {
      await db.$disconnect();
    });

    it("bootstraps a fresh user atomically: org, owner membership and workspace in one commit", async () => {
      const user = await makeUser("fresh");

      const result = await svc.ensureUserOrganization(user.id, user.email);

      expect(result.created).toBe(true);
      const membership = await db.organizationMember.findFirst({
        where: { userId: user.id },
      });
      expect(membership?.role).toBe("owner");
      expect(membership?.organizationId).toBe(result.organization.id);
      const workspace = await db.workspace.findUniqueOrThrow({
        where: { id: result.workspace.id },
      });
      expect(workspace.organizationId).toBe(result.organization.id);
      expect(workspace.createdByUserId).toBe(user.id);
      // The workspace is born seeded: personal API key + owner access binding.
      expect(
        await db.apiKey.count({
          where: { userId: user.id, workspaceId: workspace.id, kind: "user" },
        }),
      ).toBe(1);
      expect(
        await db.workspaceAccess.count({
          where: { userId: user.id, workspaceId: workspace.id },
        }),
      ).toBe(1);
    });

    it("converges on the existing workspace for an already-provisioned user", async () => {
      const user = await makeUser("idem");
      const first = await svc.ensureUserOrganization(user.id, user.email);

      const second = await svc.ensureUserOrganization(user.id, user.email);

      expect(second.created).toBe(false);
      expect(second.workspace.id).toBe(first.workspace.id);
      expect(
        await db.organizationMember.count({ where: { userId: user.id } }),
      ).toBe(1);
    });

    it("serializes concurrent calls: both resolve to the same workspace, one org", async () => {
      const user = await makeUser("race");

      const [a, b] = await Promise.all([
        svc.ensureUserOrganization(user.id, user.email),
        svc.ensureUserOrganization(user.id, user.email),
      ]);

      expect(a.workspace.id).toBe(b.workspace.id);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(
        await db.organizationMember.count({ where: { userId: user.id } }),
      ).toBe(1);
    });

    it("BLOCKS behind a lock-holding winner and converges on its commit (pins READ COMMITTED)", async () => {
      const user = await makeUser("lock");
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let signalWinnerReady!: (workspaceId: string) => void;
      const winnerReady = new Promise<string>((r) => (signalWinnerReady = r));

      // A mid-flight winner: lock taken, rows written, transaction held open.
      const winner = db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${svc.orgBootstrapLockKey(user.id)}))`;
          const org = await tx.organization.create({
            data: {
              id: `${P}lock-org`,
              name: "winner",
              slug: `${P}lock-slug`,
              members: {
                create: {
                  userId: user.id,
                  userEmail: user.email,
                  role: "owner",
                },
              },
              workspaces: {
                create: {
                  id: `${P}lock-ws`,
                  name: "winner",
                  slug: "winner",
                  createdByUserId: user.id,
                  createdByUserEmail: user.email,
                },
              },
            },
            select: { workspaces: { select: { id: true } } },
          });
          signalWinnerReady(org.workspaces[0]!.id);
          await held; // hold the lock (and the uncommitted rows) open
        },
        { timeout: 15_000 },
      );

      const winnerWorkspaceId = await winnerReady;
      const loser = svc.ensureUserOrganization(user.id, user.email);
      // The loser must be WAITING on the advisory lock, not running ahead on
      // the pre-commit snapshot (which would re-create the P2002 race).
      const settledEarly = await Promise.race([
        loser.then(() => true),
        sleep(400).then(() => false),
      ]);
      expect(settledEarly).toBe(false);

      release();
      await winner;
      const converged = await loser;

      expect(converged.created).toBe(false);
      expect(converged.workspace.id).toBe(winnerWorkspaceId);
      expect(
        await db.organizationMember.count({ where: { userId: user.id } }),
      ).toBe(1);
    });

    it("repairs the crashed-bootstrap state: owner membership, org with zero workspaces", async () => {
      const user = await makeUser("repair");
      await db.organization.create({
        data: {
          id: `${P}repair-org`,
          name: "half",
          slug: `${P}repair-slug`,
          members: {
            create: { userId: user.id, userEmail: user.email, role: "owner" },
          },
        },
      });

      const result = await svc.ensureUserOrganization(user.id, user.email);

      expect(result.created).toBe(false);
      expect(result.organization.id).toBe(`${P}repair-org`);
      const workspace = await db.workspace.findUniqueOrThrow({
        where: { id: result.workspace.id },
      });
      expect(workspace.organizationId).toBe(`${P}repair-org`);
      // Repair lands in an org with history — the slug carries the userId
      // suffix so it can never collide.
      expect(workspace.slug).toContain(user.id.slice(0, 8));
      expect(
        await db.apiKey.count({
          where: { userId: user.id, workspaceId: workspace.id, kind: "user" },
        }),
      ).toBe(1);
      // No second organization was minted.
      expect(
        await db.organizationMember.count({ where: { userId: user.id } }),
      ).toBe(1);
    });

    it("does NOT repair inside an org that still has other workspaces — fresh org instead", async () => {
      const user = await makeUser("owner-other-ws");
      await db.organization.create({
        data: {
          id: `${P}other-ws-org`,
          name: "kept",
          slug: `${P}other-ws-slug`,
          members: {
            create: { userId: user.id, userEmail: user.email, role: "owner" },
          },
          workspaces: {
            create: {
              id: `${P}other-ws`,
              name: "someone elses",
              slug: "someone-elses",
              // A departed member's workspace: creator FK long gone (null).
            },
          },
        },
      });

      const result = await svc.ensureUserOrganization(user.id, user.email);

      expect(result.created).toBe(true);
      expect(result.organization.id).not.toBe(`${P}other-ws-org`);
      // The admin-managed org gained nothing.
      expect(
        await db.workspace.count({
          where: { organizationId: `${P}other-ws-org` },
        }),
      ).toBe(1);
    });

    it("does NOT repair for a non-owner membership — fresh org instead", async () => {
      const user = await makeUser("member");
      await db.organization.create({
        data: {
          id: `${P}member-org`,
          name: "joined",
          slug: `${P}member-slug`,
          members: {
            create: { userId: user.id, userEmail: user.email, role: "member" },
          },
        },
      });

      const result = await svc.ensureUserOrganization(user.id, user.email);

      expect(result.created).toBe(true);
      expect(result.organization.id).not.toBe(`${P}member-org`);
      expect(
        await db.workspace.count({
          where: { organizationId: `${P}member-org` },
        }),
      ).toBe(0);
    });

    it("treats a suspended-only membership as no membership — fresh org", async () => {
      const user = await makeUser("suspended");
      await db.organization.create({
        data: {
          id: `${P}susp-org`,
          name: "kicked from",
          slug: `${P}susp-slug`,
          members: {
            create: {
              userId: user.id,
              userEmail: user.email,
              role: "owner",
              status: "suspended",
            },
          },
        },
      });

      const result = await svc.ensureUserOrganization(user.id, user.email);

      expect(result.created).toBe(true);
      expect(result.organization.id).not.toBe(`${P}susp-org`);
    });

    it("rethrows a slug collision when there is nothing to converge on", async () => {
      const user = await makeUser("collide");
      // A foreign org already holds this user's deterministic slug — the shape
      // an unlocked writer (EE create, a pre-fix install) can leave behind.
      const localPart = user.email.split("@")[0];
      await db.organization.create({
        data: {
          id: `${P}collide-org`,
          name: "squatter",
          slug: `${localPart}-${user.id.slice(0, 8)}`,
        },
      });

      await expect(
        svc.ensureUserOrganization(user.id, user.email),
      ).rejects.toMatchObject({ code: "P2002" });
    });
  },
);
