import { Hono } from "hono";
import { requireEnterprise } from "../middleware/enterprise-gate";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { requireWorkspaceManagement } from "../services/workspace-management-guard";
import {
  listWorkspaceAccess,
  replaceWorkspaceAccess,
} from "../services/workspace-access-service";
import {
  assertFeatureAllowed,
  assertCanShareWorkspace,
} from "../services/quota-service";
import { setWorkspaceAccessSchema } from "../validations/workspace";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

const read = auth({ requireWorkspace: false });

/**
 * The workspace ACCESS surface, composed onto the same `/workspaces` base path as
 * the shared CRUD router (`routes/workspaces.ts`) and mounted after it — exactly
 * how `agentGrantsRoutes` composes onto `/agents`.
 */
export const workspaceAccessRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("workspace_sharing"));

  // GET /workspaces/:workspaceId/access — list the workspace's human access bindings.
  // Managing access is an owner-or-admin action (not plain org membership), so
  // it uses `read` auth + an in-handler manage check rather than the `admin`
  // middleware, which would 403 a non-admin workspace owner.
  app.get("/:workspaceId/access", read, async (c) => {
    const authCtx = c.get("auth");
    const workspaceId = c.req.param("workspaceId");
    await requireWorkspaceManagement(authCtx, workspaceId);
    const bindings = await listWorkspaceAccess(
      authCtx.organizationId,
      workspaceId,
    );
    return c.json(bindings);
  });

  // PUT /workspaces/:workspaceId/access — replace the workspace's shares.
  app.put("/:workspaceId/access", read, async (c) => {
    const authCtx = c.get("auth");
    const workspaceId = c.req.param("workspaceId");
    await requireWorkspaceManagement(authCtx, workspaceId);

    const body = await c.req.json().catch(() => null);
    const parsed = setWorkspaceAccessSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    // Plan-gating: user sharing is team-tier, group bindings are enterprise.
    // Applied to *additions* only (inside replaceWorkspaceAccess, off its diff) so
    // preserving a legacy group binding on a since-downgraded org can't 403 an
    // otherwise-allowed people edit.
    const result = await withAudit(
      () =>
        replaceWorkspaceAccess(
          authCtx.organizationId,
          workspaceId,
          parsed.data,
          authCtx.userId,
          {
            assertCanAddUsers: () =>
              assertCanShareWorkspace(authCtx.organizationId),
            assertCanAddGroups: () =>
              assertFeatureAllowed(authCtx.organizationId, "groups"),
          },
        ),
      (r) => ({
        workspaceId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.WORKSPACE,
        source: AUDIT_SOURCE.API,
        metadata: {
          added: r.added,
          removed: r.removed,
          roleChanged: r.roleChanged,
        },
      }),
    );
    return c.json(result);
  });

  return app;
};
