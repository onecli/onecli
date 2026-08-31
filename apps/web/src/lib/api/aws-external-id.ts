import { apiGet, workspaceScope } from "./client";

/**
 * The organization's AWS `sts:ExternalId` — shown on the AWS Role connect
 * screen so an admin can paste it into their IAM role's trust policy.
 *
 * Always the org-scoped route, from BOTH the workspace and org connect popups:
 * the external ID is an organization-level identity, and the server resolves
 * WHICH org from the request's own scope. Nothing about the org travels in the
 * URL, so no caller can ask for someone else's — the ids below are only ever
 * "which of MY scopes", re-fenced server-side against the caller's
 * memberships.
 *
 * The scope must be passed EXPLICITLY here. `apiFetch` derives its tenancy
 * headers from `window.location.pathname`, but the connect popup's path is
 * `/app-connect/<provider>` — it carries the workspace in the QUERY STRING, so
 * the automatic headers come out empty and a cloud session (which never falls
 * back to a default workspace) resolves to no tenant at all and 401s.
 */
export const get = (scope?: { workspaceId?: string; orgId?: string }) =>
  apiGet<{ externalId: string }>(
    "/v1/org/apps/aws-external-id",
    scope?.orgId
      ? { headers: { "X-Organization-Id": scope.orgId } }
      : workspaceScope(scope?.workspaceId),
  );
