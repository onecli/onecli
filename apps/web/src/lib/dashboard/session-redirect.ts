export const getDashboardRedirect = (
  data: Record<string, unknown>,
  pathname: string,
): string | null => {
  if (!data.projectId && !pathname.startsWith("/account")) {
    return "/create-org";
  }
  return null;
};
