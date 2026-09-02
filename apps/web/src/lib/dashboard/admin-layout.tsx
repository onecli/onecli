import { redirect } from "next/navigation";
import { userIsOrgAdmin } from "@onecli/api/services/workspace-access-check";
import { resolveOrgContext } from "@/lib/actions/resolve-user";

/**
 * Layout choke-point for the org-level `(admin)` route group. Every admin/
 * owner-only screen — settings, team, global rules, global connections,
 * billing, usage — renders as a child of this layout, so the role guard runs
 * on entry into the group and members are redirected to /workspaces. Provider-
 * driven: RBAC deployments (cloud, licensed self-host) require admin/owner;
 * non-RBAC deployments enforce no roles, so every member passes (the flat
 * team — today's self-host behavior).
 *
 * Defense-in-depth: this is the route-access layer (Layer 2). The menu hides
 * these links from members (Layer 1) and the underlying server actions / API
 * routes are admin-gated (Layer 3), so the page's own data fetches fail closed
 * even if this redirect is ever bypassed. Fails closed itself: any error from
 * the role check redirects away rather than rendering the admin UI.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId, organizationId } = await resolveOrgContext();
  let allowed = false;
  try {
    allowed = await userIsOrgAdmin(userId, organizationId);
  } catch {
    allowed = false;
  }
  if (!allowed) {
    redirect(`/org/${organizationId}/workspaces`);
  }
  return <>{children}</>;
}
