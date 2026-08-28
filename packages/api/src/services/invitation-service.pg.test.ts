import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Self-hosted-shaped, and the code under test reaches Prisma at module load —
// both pins have to be hoisted or the suite reads a different edition and a
// different database than it thinks. (This exact trap cost a debugging round
// in PR 2.)
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  const proofUrl = process.env.POLICY_PROOF_DATABASE_URL;
  if (proofUrl) process.env.DATABASE_URL = proofUrl;
});

import { randomUUID } from "node:crypto";
import { db } from "@onecli/db";
import { proofDatabaseUrl } from "../testing/pg-proof.js";
import {
  createInvitation,
  acceptInvitation,
  cancelInvitation,
} from "./invitation-service";

/**
 * Accepting an invitation, against real PostgreSQL.
 *
 * The unit suite proves what the flow refuses; a mocked client can do that
 * honestly. What it cannot show is the half this test exists for: accepting
 * writes a membership AND a workspace inside one transaction, with real foreign
 * keys and a real unique constraint on `(organizationId, email)`. "The member
 * row exists but their workspace does not" is the state that would make a new
 * teammate land in a broken dashboard, and only a database can rule it out.
 *
 * Env-gated like the other proof suites; see pg-proof.ts.
 */

const PROOF_URL = proofDatabaseUrl();

const OWNER_EMAIL = `owner-${randomUUID()}@example.invalid`;
const INVITEE_EMAIL = `invitee-${randomUUID()}@example.invalid`;

interface Seeded {
  organizationId: string;
  ownerId: string;
  inviteeId: string;
}

let seeded: Seeded | null = null;

const seed = async (): Promise<Seeded> => {
  const owner = await db.user.create({
    data: { email: OWNER_EMAIL, externalAuthId: `ba:${randomUUID()}` },
  });
  const invitee = await db.user.create({
    data: { email: INVITEE_EMAIL, externalAuthId: `ba:${randomUUID()}` },
  });
  const org = await db.organization.create({
    data: {
      name: "Acme",
      slug: `acme-${owner.id.slice(0, 8)}`,
      members: {
        create: { userId: owner.id, userEmail: OWNER_EMAIL, role: "owner" },
      },
    },
  });
  return { organizationId: org.id, ownerId: owner.id, inviteeId: invitee.id };
};

const purge = async () => {
  const s = seeded;
  seeded = null;
  const users = await db.user.findMany({
    where: { email: { in: [OWNER_EMAIL, INVITEE_EMAIL] } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  const orgIds = s ? [s.organizationId] : [];
  if (orgIds.length > 0) {
    const workspaces = await db.workspace.findMany({
      where: { organizationId: { in: orgIds } },
      select: { id: true },
    });
    const workspaceIds = workspaces.map((p) => p.id);
    await db.agent.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await db.apiKey.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await db.policyRuleV2.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await db.workspaceAccess.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.invitation.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
    await db.organizationMember.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
  }
  if (userIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
};

describe.skipIf(!PROOF_URL)("invitations over real PostgreSQL", () => {
  beforeAll(purge);
  afterEach(purge);

  it("makes the invitee a member WITH their own workspace, atomically", async () => {
    seeded = await seed();
    const s = seeded;

    const { token } = await createInvitation({
      organizationId: s.organizationId,
      email: INVITEE_EMAIL,
      role: "member",
      invitedById: s.ownerId,
      invitedByEmail: OWNER_EMAIL,
    });

    const result = await acceptInvitation(
      token,
      s.inviteeId,
      INVITEE_EMAIL,
      null,
    );
    expect(result.organizationId).toBe(s.organizationId);

    const membership = await db.organizationMember.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: s.organizationId,
          userId: s.inviteeId,
        },
      },
    });
    expect(membership.role).toBe("member");
    expect(membership.userEmail).toBe(INVITEE_EMAIL);

    // The half a mock cannot vouch for: a member with no workspace lands in a
    // dashboard with nowhere to go.
    const workspace = await db.workspace.findFirstOrThrow({
      where: { organizationId: s.organizationId, createdByUserId: s.inviteeId },
    });
    expect(workspace.createdByUserEmail).toBe(INVITEE_EMAIL);

    // ...and the invitation is spent, so the link cannot be replayed.
    const invitation = await db.invitation.findUniqueOrThrow({
      where: { token },
    });
    expect(invitation.status).toBe("accepted");
  });

  it("refuses a second use of the same link", async () => {
    seeded = await seed();
    const s = seeded;

    const { token } = await createInvitation({
      organizationId: s.organizationId,
      email: INVITEE_EMAIL,
      role: "member",
      invitedById: s.ownerId,
      invitedByEmail: OWNER_EMAIL,
    });
    await acceptInvitation(token, s.inviteeId, INVITEE_EMAIL, null);

    await expect(
      acceptInvitation(token, s.inviteeId, INVITEE_EMAIL, null),
    ).rejects.toThrow(/already been used/i);
  });

  it("refuses someone the invitation was not addressed to", async () => {
    // The token is a bearer credential — anyone who sees the link holds it.
    // The email check is what stops a forwarded invitation becoming an
    // account in somebody else's organization.
    seeded = await seed();
    const s = seeded;

    const { token } = await createInvitation({
      organizationId: s.organizationId,
      email: INVITEE_EMAIL,
      role: "member",
      invitedById: s.ownerId,
      invitedByEmail: OWNER_EMAIL,
    });

    await expect(
      acceptInvitation(token, s.ownerId, "someone-else@example.invalid", null),
    ).rejects.toThrow(/different email address/i);

    expect(
      await db.organizationMember.count({
        where: { organizationId: s.organizationId },
      }),
    ).toBe(1);
  });

  it("re-inviting the same address reuses the row rather than duplicating it", async () => {
    // `(organizationId, email)` is unique, so a resend has to be an upsert —
    // otherwise the second invite would throw a constraint error at whoever
    // clicked "invite" again.
    seeded = await seed();
    const s = seeded;

    const first = await createInvitation({
      organizationId: s.organizationId,
      email: INVITEE_EMAIL,
      role: "member",
      invitedById: s.ownerId,
      invitedByEmail: OWNER_EMAIL,
    });
    await cancelInvitation(s.organizationId, first.id);

    const second = await createInvitation({
      organizationId: s.organizationId,
      email: INVITEE_EMAIL,
      role: "admin",
      invitedById: s.ownerId,
      invitedByEmail: OWNER_EMAIL,
    });

    expect(second.id).toBe(first.id);
    expect(second.token).not.toBe(first.token);
    expect(
      await db.invitation.count({
        where: { organizationId: s.organizationId },
      }),
    ).toBe(1);
  });
});
