/**
 * Whether the session belongs to no org: no workspace of its own, and (on
 * cloud, which reports it) no membership either. Such a viewer goes to org
 * creation, except on the account's addresses, which stay theirs.
 */
export const isOrgless = (data: Record<string, unknown>): boolean =>
  !data.workspaceId && !data.hasOrg;

export const getDashboardRedirect = (
  data: Record<string, unknown>,
  pathname: string,
): string | null => {
  if (isOrgless(data) && !pathname.startsWith("/account")) {
    return "/create-org";
  }

  const isOrgPage = pathname.startsWith("/org/") || pathname === "/org";

  if (
    !data.workspaceId &&
    data.hasOrg &&
    !pathname.startsWith("/account") &&
    !isOrgPage
  ) {
    // Send straight to the org index, which server-redirects to the validated
    // /org/<defaultOrgId>/workspaces. Returning "/" instead would bounce through
    // the home page's client resolver and cause a visible double redirect.
    return "/org";
  }

  return null;
};
