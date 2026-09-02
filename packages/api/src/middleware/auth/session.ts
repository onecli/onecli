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

export const authenticateSession = async (
  request: Request,
  requireWorkspace: boolean,
): Promise<SessionAuthResult> => {
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

  const workspaceId = await resolveWorkspaceId(request, dbUser.id);

  if (!workspaceId && requireWorkspace) return null;

  if (workspaceId) {
    const organizationId =
      await resolveOrganizationIdFromWorkspace(workspaceId);
    if (!organizationId) return null;

    return {
      userId: dbUser.id,
      userEmail: user.email,
      workspaceId,
      organizationId,
      scope: "session",
    };
  }

  const organizationId = await resolveOrganizationId(request, dbUser.id);
  if (!organizationId) return null;

  return {
    userId: dbUser.id,
    userEmail: user.email,
    workspaceId: undefined,
    organizationId,
    scope: "session",
  };
};
