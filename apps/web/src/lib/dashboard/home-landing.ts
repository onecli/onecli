import { getUserDefaultOrgId } from "@/lib/auth/default-org";
import { orgHomePath } from "@/lib/navigation";
import { resolveOrgLanding } from "./org-landing";

/**
 * The page "go to this org" ends on, resolved now instead of redirected
 * to: the first workspace the viewer may open, on its first agent, the
 * same place `/org/<id>/workspaces` forwards to. Handing back the final
 * URL lets a caller go there in one navigation. Navigating to the
 * forwarding URL instead renders the dashboard around it first (the
 * session gate holds the page back, so its redirect only runs once the
 * shell is up), which flashed an empty shell on every sign-in. With
 * nowhere to land (no workspace they may open, or no membership in
 * `orgId`, which `resolveOrgLanding` fences), the org's workspaces page,
 * whose layout turns a non-member away.
 */
export const resolveOrgHome = async (orgId: string): Promise<string> =>
  (await resolveOrgLanding(orgId)) ?? orgHomePath(orgId);

/**
 * Where a signed-in visitor with no URL of their own lands: their default
 * org's home (the last-viewed org, validated against their memberships,
 * so a cookie left by another account can never misroute). Null when they
 * belong to no org.
 */
export const resolveDefaultHome = async (): Promise<string | null> => {
  const orgId = await getUserDefaultOrgId();
  return orgId ? resolveOrgHome(orgId) : null;
};
