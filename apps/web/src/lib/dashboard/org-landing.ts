import { db } from "@onecli/db";
import {
  getUserRole,
  visibleWorkspacesWhere,
} from "@onecli/api/ee/services/authorization-service";
import { getServerSession } from "@/lib/auth/server";
import { workspaceLandingPath } from "@/lib/agents/agent-order";

/**
 * Where an org-level landing URL (`/org/<id>`, `/org/<id>/workspaces`)
 * forwards: the first workspace the viewer may open, on its first agent
 * (the same door a bare `/w/<id>` opens, resolved here in one hop so a
 * query string on the way in, `?settings=<page>`, survives: the front
 * door's own redirect would drop it). Null when the viewer has no
 * workspace to land in (the workspaces page then shows its empty state,
 * and admins their create button).
 *
 * Fenced on its own, never leaning on the org layout: Next renders a layout
 * and its page concurrently, and the account redirects call this for an
 * org the URL never named. A viewer with no active membership in `orgId`
 * gets null (no workspace or agent id ever leaves for a foreign org); a
 * member picks among the workspaces their membership (or an access
 * binding) makes visible, the same predicate the workspaces list uses.
 */
export const resolveOrgLanding = async (
  orgId: string,
): Promise<string | null> => {
  const session = await getServerSession();
  if (!session) return null;
  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true },
  });
  if (!user) return null;
  // Null for a non-member or a suspended one. Checked before the predicate:
  // without RBAC, `visibleWorkspacesWhere` treats every caller as able to
  // see the whole org, membership included.
  const role = await getUserRole(user.id, orgId);
  if (!role) return null;
  const workspace = await db.workspace.findFirst({
    where: visibleWorkspacesWhere(user.id, orgId, role),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!workspace) return null;
  const firstAgent = await db.agent.findFirst({
    where: { workspaceId: workspace.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, kind: true },
  });
  return workspaceLandingPath(workspace.id, firstAgent);
};
