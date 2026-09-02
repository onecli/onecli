export const getDashboardRedirect = (
  data: Record<string, unknown>,
  pathname: string,
): string | null => {
  if (!data.workspaceId && !data.hasOrg && !pathname.startsWith("/account")) {
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
