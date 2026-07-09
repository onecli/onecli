import { db } from "@onecli/db";
import type { AuthContext } from "../../providers";
import { getRoleResolver, ROLE_HIERARCHY } from "../../providers";
import { CAPS } from "../../lib/env";
import { resolveUserEmail, canAccessProjectAsUser } from "./resolve";

/**
 * API-key authentication result:
 *
 * - `AuthContext` — a valid key resolved its scope.
 * - `"missing-project"` — a *valid* org key (found + admin re-checked) hit a
 *   `requireProject` route without an `X-Project-Id` header. Distinguished so
 *   strict mode can tell the caller to name a project — without misleading a
 *   revoked-key holder, and mirroring the gateway, whose header message also
 *   fires only after a successful key lookup.
 * - `"invalid-key"` — an `oc_` bearer was presented but failed authentication
 *   (unknown/revoked key, demoted holder, project outside the key's org, …).
 * - `null` — the request carried no `oc_` bearer at all (no header, another
 *   scheme, or a non-OneCLI token) — nothing here to authenticate.
 *
 * Non-strict callers treat both string sentinels exactly like `null` (fall
 * through to session auth); strict mode turns them into precise 401s.
 */
export type ApiKeyAuthResult =
  | AuthContext
  | "missing-project"
  | "invalid-key"
  | null;

export const authenticateApiKey = async (
  request: Request,
  requireProject: boolean,
): Promise<ApiKeyAuthResult> => {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token || !token.startsWith("oc_")) return null;

  // Org key (oc_org_*)
  if (token.startsWith("oc_org_")) {
    const apiKey = await db.apiKey.findUnique({
      where: { key: token },
      select: { userId: true, organizationId: true, scope: true },
    });
    if (!apiKey || apiKey.scope !== "organization" || !apiKey.organizationId)
      return "invalid-key";

    // Org keys are an admin capability — re-check the key's user still holds
    // admin/owner in the org (only when RBAC is active; non-RBAC editions enforce
    // no roles). Closes the gap where a key keeps working after a demotion.
    if (CAPS.rbac) {
      const resolver = getRoleResolver();
      const role = resolver
        ? await resolver.getUserRole(apiKey.userId, apiKey.organizationId)
        : null;
      if (!role || ROLE_HIERARCHY[role] < ROLE_HIERARCHY.admin)
        return "invalid-key";
    }

    const userEmail = await resolveUserEmail(apiKey.userId);
    const headerProjectId = request.headers.get("x-project-id");

    if (requireProject && !headerProjectId) return "missing-project";

    if (headerProjectId) {
      const project = await db.project.findFirst({
        where: {
          id: headerProjectId,
          organizationId: apiKey.organizationId,
        },
        select: { id: true },
      });
      if (!project) return "invalid-key";

      return {
        userId: apiKey.userId,
        userEmail,
        projectId: project.id,
        organizationId: apiKey.organizationId,
      };
    }

    return {
      userId: apiKey.userId,
      userEmail,
      projectId: undefined,
      organizationId: apiKey.organizationId,
    };
  }

  // Project key (oc_*)
  const apiKey = await db.apiKey.findUnique({
    where: { key: token },
    select: { userId: true, projectId: true },
  });
  if (!apiKey || !apiKey.projectId) return "invalid-key";

  const project = await db.project.findUnique({
    where: { id: apiKey.projectId },
    select: { createdByUserId: true, organizationId: true },
  });
  if (!project) return "invalid-key";

  // Re-check access at request time: the key authenticates only while its user
  // still has access to the project (creator, or org admin/owner). OSS is a
  // no-op (single-user, no role resolver). Mirrors resolveProjectId.
  if (!(await canAccessProjectAsUser(apiKey.userId, project)))
    return "invalid-key";

  const userEmail = await resolveUserEmail(apiKey.userId);

  return {
    userId: apiKey.userId,
    userEmail,
    projectId: apiKey.projectId,
    organizationId: project.organizationId,
  };
};
