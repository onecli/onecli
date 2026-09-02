import { Hono } from "hono";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { auth } from "../middleware/auth";
import { getRoleResolver, getSessionProvider } from "../providers";
import { logger } from "../lib/logger";
import { ServiceError } from "../services/errors";
import {
  listPendingInvitations,
  createInvitation,
  acceptInvitation,
  cancelInvitation,
} from "../services/invitation-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";
import {
  createInvitationSchema,
  acceptInvitationSchema,
} from "../validations/invitations";
import {
  buildInviteUrl,
  sendInvitationEmail,
} from "../services/invitation-email";

/**
 * Org membership, not a role.
 *
 * `auth({ role: "admin" })` asks the role resolver, and an UNLICENSED
 * self-host has none — so that option refuses everyone on exactly the edition
 * invitations were freed for. Role enforcement is the RBAC feature and stays
 * enterprise; free self-host is a flat team where every member can invite.
 * Where a resolver does exist (cloud, or a licensed self-host) the admin
 * requirement is applied below, matching the behaviour the server actions had.
 */
const member = auth({ requireWorkspace: false });

const requireAdminWhereRolesExist = async (
  userId: string,
  organizationId: string,
): Promise<boolean> => {
  const resolver = getRoleResolver();
  // No resolver = no role enforcement on this deployment (flat team).
  if (!resolver) return true;
  const role = await resolver.getUserRole(userId, organizationId);
  return role === "admin" || role === "owner";
};

/**
 * Managing an organization's invitations. Free on every edition — the seat cap
 * a cloud plan applies reaches the service through `TeamHooks`, not through a
 * gate here.
 *
 * Mounted at `/v1/org/invitations`, so every route is scoped to the caller's
 * organization and restricted to its admins. Redeeming an invitation is NOT
 * here — see `invitationAcceptRoutes` below for why.
 */
export const orgInvitationRoutes = () => {
  const app = new Hono<ApiEnv>();

  app.get("/", member, async (c) => {
    const { organizationId, userId } = c.get("auth");
    if (!(await requireAdminWhereRolesExist(userId, organizationId))) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
    return c.json(await listPendingInvitations(organizationId));
  });

  app.post("/", member, async (c) => {
    const authCtx = c.get("auth");
    if (
      !(await requireAdminWhereRolesExist(
        authCtx.userId,
        authCtx.organizationId,
      ))
    ) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
    const parsed = createInvitationSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid invitation" },
        400,
      );
    }

    const invitation = await withAudit(
      () =>
        createInvitation({
          organizationId: authCtx.organizationId,
          email: parsed.data.email,
          role: parsed.data.role,
          invitedById: authCtx.userId,
          invitedByEmail: authCtx.userEmail,
        }),
      (result) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.INVITE,
        service: AUDIT_SERVICES.INVITATION,
        source: AUDIT_SOURCE.API,
        // The token is the credential — the audit trail records who was
        // invited to what, never the means of redeeming it.
        metadata: {
          invitationId: result.id,
          email: parsed.data.email,
          role: parsed.data.role,
        },
      }),
    );

    // Delivery is additive: the inviter always gets a link they can paste,
    // and email goes out on top of it where a provider is configured. Never
    // fail the invitation because the mail did not go — it already exists,
    // and the link works.
    const org = await db.organization.findUniqueOrThrow({
      where: { id: authCtx.organizationId },
      select: { name: true },
    });
    const emailed = await sendInvitationEmail({
      recipientEmail: parsed.data.email,
      inviterEmail: authCtx.userEmail,
      organizationName: org.name,
      ownerEmail: authCtx.userEmail,
      token: invitation.token,
    }).catch(() => false);

    return c.json(
      {
        id: invitation.id,
        joinUrl: buildInviteUrl(invitation.token),
        emailed,
      },
      201,
    );
  });

  app.delete("/:id", member, async (c) => {
    const authCtx = c.get("auth");
    if (
      !(await requireAdminWhereRolesExist(
        authCtx.userId,
        authCtx.organizationId,
      ))
    ) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
    const invitationId = c.req.param("id");

    // Fenced on the organization, so another org's invitation id reads as
    // absent rather than as forbidden.
    const invitation = await db.invitation.findFirst({
      where: {
        id: invitationId,
        organizationId: authCtx.organizationId,
        status: "pending",
      },
      select: { email: true },
    });
    if (!invitation) return c.json({ error: "Invitation not found" }, 404);

    await withAudit(
      () => cancelInvitation(authCtx.organizationId, invitationId),
      () => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.INVITATION,
        source: AUDIT_SOURCE.API,
        metadata: { invitationId, email: invitation.email },
      }),
    );

    return c.body(null, 204);
  });

  return app;
};

/**
 * Redeeming an invitation, deliberately NOT under `/org`.
 *
 * The caller is not a member of the organization yet — that is the whole point
 * — so an org-scoped route would refuse them before the token was ever read.
 * The token identifies the organization; the session identifies the person;
 * the service checks that the invitation was addressed to them.
 */
export const invitationAcceptRoutes = () => {
  const app = new Hono<ApiEnv>();

  app.post("/accept", async (c) => {
    // Deliberately NOT the auth middleware: it resolves the caller's
    // organization, and someone redeeming an invitation has none yet — that
    // is the whole point. Only the session is needed here; the token names
    // the organization, and the service checks it was addressed to them.
    const session = await getSessionProvider().getSession(c.req.raw);
    if (!session?.email) return c.json({ error: "Not authenticated" }, 401);

    const user = await db.user.findUnique({
      where: { externalAuthId: session.id },
      select: { id: true, email: true, name: true },
    });
    if (!user) return c.json({ error: "Not authenticated" }, 401);
    const parsed = acceptInvitationSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "A token is required" }, 400);
    }

    // The refusals here are all things a person can hit by accident — a link
    // used twice, one that expired, one addressed to a different account. The
    // service reports them as plain errors, so they would otherwise surface as
    // a 500 and read as a crash rather than as an answer.
    let result: Awaited<ReturnType<typeof acceptInvitation>>;
    try {
      result = await acceptInvitation(
        parsed.data.token,
        user.id,
        user.email,
        user.name,
      );
    } catch (err) {
      logger.warn({ err, userId: user.id }, "invitation could not be accepted");
      // Only the service's own refusals are safe to repeat back — they were
      // written for the person reading them. Anything else is a fault, and
      // echoing its message would hand out internals (a Prisma error names
      // columns and constraints).
      if (err instanceof ServiceError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    // Audited against the organization being JOINED, not the caller's current
    // one — an accept is the first thing that happens in that org's history
    // for this person, and it was unaudited entirely until now.
    await withAudit(
      async () => result,
      () => ({
        organizationId: result.organizationId,
        userId: user.id,
        userEmail: user.email,
        action: AUDIT_ACTIONS.ACCEPT,
        service: AUDIT_SERVICES.INVITATION,
        source: AUDIT_SOURCE.API,
        metadata: { email: user.email },
      }),
    );

    return c.json(result);
  });

  return app;
};
