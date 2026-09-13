import crypto from "crypto";
import { db } from "@onecli/db";
import { ServiceError } from "./errors";
import {
  ASSIGNABLE_MEMBER_ROLES,
  memberProvisionOps,
} from "./organization-service";
import { getTeamHooks } from "../providers/hooks/team-hooks";

/**
 * Team invitations — free on every edition.
 *
 * Collaboration is not an enterprise feature: a self-hosted deployment can
 * invite its team and work together without a licence. What IS edition-specific
 * — a cloud plan's seat allowance, and enterprise directory role mapping — sits
 * behind `TeamHooks` rather than inside this file, which is what let it move out
 * from under the licensed paths.
 */

const INVITE_EXPIRY_DAYS = 7;

const generateInviteToken = (): string =>
  crypto.randomBytes(32).toString("hex");

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  invitedByEmail: string;
  expiresAt: Date;
  createdAt: Date;
}

export const listPendingInvitations = async (
  organizationId: string,
): Promise<PendingInvitation[]> => {
  const invitations = await db.invitation.findMany({
    where: { organizationId, status: "pending" },
    select: {
      id: true,
      email: true,
      role: true,
      invitedByEmail: true,
      expiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return invitations.map((inv) => ({
    ...inv,
    status: inv.expiresAt < new Date() ? "expired" : "pending",
  }));
};

export const createInvitation = async (params: {
  organizationId: string;
  email: string;
  role: string;
  invitedById: string;
  invitedByEmail: string;
}): Promise<{ token: string; id: string }> => {
  if (!ASSIGNABLE_MEMBER_ROLES.has(params.role)) {
    throw new Error("Invalid role");
  }
  const existing = await db.organizationMember.findFirst({
    where: {
      organizationId: params.organizationId,
      userEmail: params.email,
    },
    select: { userId: true },
  });

  if (existing) {
    throw new Error("This user is already a member of the organization");
  }

  // Seat cap: existing members always stay; only NEW seats are gated. A
  // resend of a still-pending invitation is seat-neutral (that invite already
  // counts as a committed seat), so it skips the cap — while reclaiming a
  // cancelled/expired/accepted row charges the seat again.
  const prior = await db.invitation.findUnique({
    where: {
      organizationId_email: {
        organizationId: params.organizationId,
        email: params.email,
      },
    },
    select: { status: true, expiresAt: true },
  });
  const isPendingResend =
    prior?.status === "pending" && prior.expiresAt >= new Date();
  if (!isPendingResend) {
    await getTeamHooks().beforeInviteMember(params.organizationId);
  }

  const token = generateInviteToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + INVITE_EXPIRY_DAYS);

  const invitation = await db.invitation.upsert({
    where: {
      organizationId_email: {
        organizationId: params.organizationId,
        email: params.email,
      },
    },
    create: {
      organizationId: params.organizationId,
      email: params.email,
      role: params.role,
      token,
      invitedById: params.invitedById,
      invitedByEmail: params.invitedByEmail,
      expiresAt,
    },
    update: {
      role: params.role,
      token,
      status: "pending",
      invitedById: params.invitedById,
      invitedByEmail: params.invitedByEmail,
      expiresAt,
    },
    select: { id: true, token: true },
  });

  return { token: invitation.token, id: invitation.id };
};

export const acceptInvitation = async (
  token: string,
  userId: string,
  userEmail: string,
  // The accepter's display name — seeds their new workspace's name (falls
  // back to the email when null).
  userName: string | null,
): Promise<{ organizationId: string; organizationName: string }> => {
  const invitation = await db.invitation.findUnique({
    where: { token },
    select: {
      id: true,
      organizationId: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
      organization: { select: { name: true } },
    },
  });

  if (!invitation) {
    throw new ServiceError("BAD_REQUEST", "Invalid invitation link");
  }

  if (invitation.status !== "pending") {
    throw new ServiceError(
      "BAD_REQUEST",
      "This invitation has already been used or cancelled",
    );
  }

  if (invitation.expiresAt < new Date()) {
    await db.invitation.update({
      where: { id: invitation.id },
      data: { status: "expired" },
    });
    throw new ServiceError("BAD_REQUEST", "This invitation has expired");
  }

  if (invitation.email.toLowerCase() !== userEmail.toLowerCase()) {
    throw new ServiceError(
      "BAD_REQUEST",
      "This invitation was sent to a different email address. Please sign in with the correct account.",
    );
  }

  await db.$transaction([
    ...memberProvisionOps(
      invitation.organizationId,
      userId,
      userEmail,
      invitation.role,
      userName,
    ),
    db.invitation.update({
      where: { id: invitation.id },
      data: { status: "accepted" },
    }),
  ]);

  await getTeamHooks().afterMemberJoined(invitation.organizationId, userId);

  return {
    organizationId: invitation.organizationId,
    organizationName: invitation.organization.name,
  };
};

export const cancelInvitation = async (
  organizationId: string,
  invitationId: string,
): Promise<void> => {
  await db.invitation.update({
    where: { id: invitationId, organizationId, status: "pending" },
    data: { status: "cancelled" },
  });
};

/**
 * Resolve a join link's token to what the invited person may be shown.
 *
 * The organization's name comes from here rather than from the URL, so a
 * crafted `/join?name=…` cannot make an invitation look like it came from
 * somewhere it did not.
 */
export const findPendingInvitationByToken = async (
  token: string,
  prisma: typeof db = db,
) => {
  const invitation = await prisma.invitation.findUnique({
    where: { token },
    select: {
      email: true,
      status: true,
      expiresAt: true,
      organization: { select: { name: true, slug: true } },
    },
  });
  if (!invitation) return null;
  if (invitation.status !== "pending") return null;
  if (invitation.expiresAt < new Date()) return null;
  return {
    email: invitation.email,
    organizationName: invitation.organization.name,
    organizationSlug: invitation.organization.slug,
  };
};

/**
 * A join link that was already redeemed by THIS user.
 *
 * People re-click invitation emails: the token is single-use, so the pending
 * lookup above says "invalid", but the person is a member and the right move
 * is to land them in the organization rather than on an error. Returns the
 * organization id when the token belongs to an accepted invitation whose
 * email matches the signed-in user and they hold an active membership there;
 * null in every other case (unknown token, someone else's invitation,
 * cancelled/expired, or membership since removed or suspended).
 */
export const findAcceptedInvitationOrgForUser = async (
  token: string,
  userId: string,
  userEmail: string,
  prisma: typeof db = db,
): Promise<string | null> => {
  const invitation = await prisma.invitation.findUnique({
    where: { token },
    select: { email: true, status: true, organizationId: true },
  });
  if (!invitation || invitation.status !== "accepted") return null;
  if (invitation.email.toLowerCase() !== userEmail.toLowerCase()) return null;

  const membership = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: invitation.organizationId,
        userId,
      },
    },
    select: { status: true },
  });
  if (!membership || membership.status === "suspended") return null;
  return invitation.organizationId;
};

export type UnavailableInvitationReason =
  | "expired"
  | "accepted"
  | "cancelled"
  | "unknown";

/**
 * Why a join link cannot be redeemed, for the page that has to say so.
 *
 * Reveals nothing beyond the status word: the organization's name and the
 * invitee's address stay out of it, since anyone holding a guessed or leaked
 * token could otherwise learn who invited whom. "accepted" here means
 * someone ELSE redeemed it (or the accepter is no longer a member); the
 * accepter's own re-click is answered by `findAcceptedInvitationOrgForUser`
 * before this is consulted.
 */
export const explainUnavailableInvitation = async (
  token: string,
  prisma: typeof db = db,
): Promise<UnavailableInvitationReason> => {
  const invitation = await prisma.invitation.findUnique({
    where: { token },
    select: { status: true, expiresAt: true },
  });
  if (!invitation) return "unknown";
  if (invitation.status === "accepted") return "accepted";
  if (invitation.status === "cancelled") return "cancelled";
  // "pending" past its date reads as expired too — the status column only
  // flips lazily, on an attempted accept.
  if (invitation.status === "expired" || invitation.expiresAt < new Date())
    return "expired";
  return "unknown";
};
