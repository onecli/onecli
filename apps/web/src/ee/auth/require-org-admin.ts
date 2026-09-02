import { redirect } from "next/navigation";
import { resolveOrgContext } from "@/lib/actions/resolve-user";
import { requireRole } from "@onecli/api/ee/services/authorization-service";

/**
 * Route guard (Layer 2) for org-level admin/owner-only screens.
 *
 * Resolves the org from request headers and redirects anyone below the "admin"
 * role (i.e. members) to the org's workspaces list. This is the UX redirect — the
 * real enforcement lives in the data layer: the admin-gated server actions and
 * the admin-gated `/v1/org/*` API routes. A member who somehow reaches an admin
 * page still gets FORBIDDEN on every data fetch.
 *
 * Fails closed: any error from the role check (including a transient DB error)
 * redirects away rather than rendering the admin UI.
 */
export const requireOrgAdmin = async () => {
  const { userId, organizationId } = await resolveOrgContext();
  try {
    await requireRole(userId, organizationId, "admin");
  } catch {
    redirect(`/org/${organizationId}/workspaces`);
  }
};
