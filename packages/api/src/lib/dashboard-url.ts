import { APP_URL } from "./env";

export const dashboardUrl = (
  path: string,
  scope?: { projectId?: string; organizationId?: string },
): string => {
  if (scope?.projectId) return `${APP_URL}/p/${scope.projectId}${path}`;
  if (scope?.organizationId)
    return `${APP_URL}/org/${scope.organizationId}${path}`;
  return `${APP_URL}${path}`;
};
