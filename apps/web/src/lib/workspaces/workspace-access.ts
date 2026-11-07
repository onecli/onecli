import { cache } from "react";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server";
import { db } from "@onecli/db";
import { canAccessWorkspaceAsUser } from "@onecli/api/services/workspace-access-check";

/**
 * The workspace the signed-in user may open, or a redirect: `/auth/login`
 * without a session, `/org` for a workspace that is missing, foreign, or
 * withheld by RBAC.
 *
 * Shared by the workspace layout AND any workspace page whose own output
 * depends on workspace data (the landing redirect names an agent). Next
 * renders a layout and its page concurrently, so a page cannot lean on the
 * layout's check having already run — it calls this itself. `cache()` makes
 * the second call in the same request free.
 *
 * Usage is bindings-only since step 13b — the creator arm was dropped, so on
 * RBAC deployments (cloud, licensed self-host) every user must hold a
 * WorkspaceAccess binding (direct or group) or be an org admin/owner to open
 * the workspace; non-RBAC deployments enforce no roles. The provider-driven
 * shared check is the same one the auth middleware runs, so the layout and
 * the API can never disagree. The findFirst below already excludes suspended
 * members.
 */
export const requireAccessibleWorkspace = cache(
  async (
    workspaceId: string,
  ): Promise<{ id: string; name: string | null; organizationId: string }> => {
    const session = await getServerSession();
    if (!session) redirect("/auth/login");

    const user = await db.user.findUnique({
      where: { externalAuthId: session.id },
      select: { id: true },
    });
    if (!user) redirect("/auth/login");

    const workspace = await db.workspace.findFirst({
      where: {
        id: workspaceId,
        organization: {
          members: { some: { userId: user.id, status: { not: "suspended" } } },
        },
      },
      select: { id: true, name: true, organizationId: true },
    });
    if (!workspace) redirect("/org");

    if (!(await canAccessWorkspaceAsUser(user.id, workspace))) {
      redirect("/org");
    }
    return workspace;
  },
);
