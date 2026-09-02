import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { auth } from "../middleware/auth";
import {
  listOrgWorkspacesForUser,
  getWorkspaceById,
  createOrgWorkspace,
  updateOrgWorkspace,
  deleteOrgWorkspace,
} from "../ee/services/workspace-service";
import { getUserRole } from "../ee/services/authorization-service";
import { requireWorkspaceManagement } from "../ee/services/workspace-management-guard";
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
} from "../validations/workspace";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";

const read = auth({ requireWorkspace: false });
const admin = auth({ requireWorkspace: false, role: "admin" });

export const workspaceRoutes = () => {
  const app = new Hono<ApiEnv>();

  // GET /workspaces
  app.get("/", read, async (c) => {
    const authCtx = c.get("auth");
    const role = await getUserRole(authCtx.userId, authCtx.organizationId);
    const workspaces = await listOrgWorkspacesForUser(
      authCtx.userId,
      authCtx.organizationId,
      role,
    );
    return c.json(workspaces);
  });

  // GET /workspaces/:workspaceId
  app.get("/:workspaceId", read, async (c) => {
    const authCtx = c.get("auth");
    const targetId = c.req.param("workspaceId");
    const role = await getUserRole(authCtx.userId, authCtx.organizationId);
    const workspace = await getWorkspaceById(
      authCtx.userId,
      authCtx.organizationId,
      targetId,
      role,
    );
    return c.json(workspace);
  });

  // POST /workspaces (admin+)
  app.post("/", admin, async (c) => {
    const authCtx = c.get("auth");

    const body = await c.req.json().catch(() => null);
    const parsed = createWorkspaceSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const workspace = await withAudit(
      () =>
        createOrgWorkspace(authCtx.organizationId, authCtx.userId, parsed.data),
      (p) => ({
        workspaceId: p.id,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.WORKSPACE,
        source: AUDIT_SOURCE.API,
        metadata: { name: p.name, organizationId: authCtx.organizationId },
      }),
    );
    return c.json(workspace, 201);
  });

  // PATCH /workspaces/:workspaceId — rename. A MANAGE action (owner-or-admin, not
  // plain org membership), so `read` auth + an in-handler manage check like the
  // /access routes; the `admin` middleware would 403 a non-admin workspace owner.
  app.patch("/:workspaceId", read, async (c) => {
    const authCtx = c.get("auth");

    const targetId = c.req.param("workspaceId");
    await requireWorkspaceManagement(authCtx, targetId);
    const body = await c.req.json().catch(() => null);
    const parsed = updateWorkspaceSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const workspace = await withAudit(
      () => updateOrgWorkspace(authCtx.organizationId, targetId, parsed.data),
      (p) => ({
        workspaceId: targetId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.WORKSPACE,
        source: AUDIT_SOURCE.API,
        metadata: { name: p.name },
      }),
    );
    return c.json(workspace);
  });

  // DELETE /workspaces/:workspaceId — a MANAGE action (owner-or-admin); see PATCH.
  // `deleteOrgWorkspace` keeps the org-scoped "can't delete the only workspace"
  // guard and flushes the gateway cache for the deleted keys.
  app.delete("/:workspaceId", read, async (c) => {
    const authCtx = c.get("auth");

    const targetId = c.req.param("workspaceId");
    await requireWorkspaceManagement(authCtx, targetId);
    await withAudit(
      () => deleteOrgWorkspace(authCtx.organizationId, targetId),
      () => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.WORKSPACE,
        source: AUDIT_SOURCE.API,
        metadata: {
          workspaceId: targetId,
          organizationId: authCtx.organizationId,
        },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
