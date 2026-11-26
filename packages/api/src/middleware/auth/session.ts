import { db } from "@onecli/db";
import type { AuthContext, SessionDenial } from "../../providers";
import { getSessionProvider, getSessionEnforcer } from "../../providers";
import {
  resolveOrganizationId,
  resolveOrganizationIdFromWorkspace,
  resolveWorkspaceId,
} from "./resolve";

/**
 * Session auth outcome: an AuthContext, `null` (no/unusable session — falls
 * through to the generic 401), or `{ denied }` when the edition's session
 * enforcer rejected an otherwise-valid session (mapped to an explicit 401 by
 * the auth middleware — mirrors authenticateApiKey's sentinel returns).
 */
export type SessionAuthResult = AuthContext | { denied: SessionDenial } | null;

/** The person behind a session, before any tenancy is resolved. */
export interface SessionUserContext {
  userId: string;
  userEmail: string;
}

export type SessionUserResult =
  | SessionUserContext
  | { denied: SessionDenial }
  | null;

/**
 * The tenancy-free half of session auth: the session provider's user, their
 * DB row, and the edition's session policy (enterprise "require SSO"). Shared
 * by `authenticateSession` (which goes on to resolve a workspace/org) and the
 * session-only surfaces that deliberately have NO tenancy — account-level
 * routes must keep working for a user who belongs to no organization at all.
 */
export const resolveSessionUser = async (
  request: Request,
): Promise<SessionUserResult> => {
  const session = getSessionProvider();
  const user = await session.getSession(request);
  if (!user) return null;

  const dbUser = await db.user.findUnique({
    where: { externalAuthId: user.id },
    select: { id: true, email: true },
  });
  if (!dbUser) return null;

  // Edition session policy (e.g. enterprise "require SSO") — before workspace
  // resolution so a rejected session fails early and explicitly.
  const enforcer = getSessionEnforcer();
  if (enforcer) {
    const denial = await enforcer(user, dbUser);
    if (denial) return { denied: denial };
  }

  return { userId: dbUser.id, userEmail: user.email };
};

export const authenticateSession = async (
  request: Request,
  requireWorkspace: boolean,
): Promise<SessionAuthResult> => {
  const resolved = await resolveSessionUser(request);
  if (!resolved || "denied" in resolved) return resolved;
  const { userId, userEmail } = resolved;

  const workspaceId = await resolveWorkspaceId(request, userId);

  if (!workspaceId && requireWorkspace) return null;

  if (workspaceId) {
    const organizationId =
      await resolveOrganizationIdFromWorkspace(workspaceId);
    if (!organizationId) return null;

    return {
      userId,
      userEmail,
      workspaceId,
      organizationId,
      scope: "session",
    };
  }

  const organizationId = await resolveOrganizationId(request, userId);
  if (!organizationId) return null;

  return {
    userId,
    userEmail,
    workspaceId: undefined,
    organizationId,
    scope: "session",
  };
};
