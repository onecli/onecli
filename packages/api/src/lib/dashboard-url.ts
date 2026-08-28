import { appOrigin } from "./public-origins";
import { configuredAppUrl } from "./app-origin";

/**
 * Absolute URL to a dashboard page.
 *
 * `fallbackOrigin` is used only when no `APP_URL` was explicitly configured —
 * pass the caller's request origin (`getRequestOrigin(...)`) when there is a
 * request in scope, so self-hosted deployments stop handing out
 * `http://localhost:10254` links they can't reach.
 *
 * Omit it when the link must reach the dashboard even though this process may
 * be answering on a different origin — a deployment that serves the API and the
 * dashboard on separate hosts configures `APP_URL`, so it wins and the link
 * stays on the dashboard. Third-party redirect URLs (payment checkout/return)
 * are that case.
 */
export const dashboardUrl = (
  path: string,
  scope?: { workspaceId?: string; organizationId?: string },
  fallbackOrigin?: string,
): string => {
  const base = configuredAppUrl() ?? fallbackOrigin ?? appOrigin();
  if (scope?.workspaceId) return `${base}/w/${scope.workspaceId}${path}`;
  if (scope?.organizationId)
    return `${base}/org/${scope.organizationId}${path}`;
  return `${base}${path}`;
};
