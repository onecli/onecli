import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { invalidateGatewayCache } from "../lib/gateway-invalidate";
import {
  listSecrets,
  createSecret,
  updateSecret,
  deleteSecret,
} from "../services/secret-service";
import { createSecretSchema, updateSecretSchema } from "../validations/secret";
import { getResourceHooks } from "../providers";
import { getSecretAgentAccess } from "../services/grants-service";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  withAudit,
} from "../services/audit-service";

export const secretRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /secrets
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const secrets = await listSecrets({
      workspaceId: requireWorkspaceId(auth),
      organizationId: auth.organizationId,
    });
    return c.json(secrets);
  });

  // POST /secrets
  app.post("/", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = createSecretSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    await getResourceHooks().beforeCreateSecret(auth.organizationId);

    const workspaceId = requireWorkspaceId(auth);
    const secret = await withAudit(
      () =>
        createSecret(
          { workspaceId },
          parsed.data,
          // The grantor recorded on an auto-attached LLM key grant (a custom
          // secret is granted to no agent).
          auth.userId,
        ),
      (created) => ({
        workspaceId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.SECRET,
        source: AUDIT_SOURCE.API,
        // Ids and names only, never the value.
        metadata: {
          secretId: created.id,
          name: parsed.data.name,
          type: parsed.data.type,
        },
      }),
    );
    invalidateGatewayCache(c.req.raw);
    return c.json(secret, 201);
  });

  // GET /secrets/:secretId/agents: every agent of the workspace against this
  // secret: the custom connection's "choose agents" window (read-only, no
  // audit). Toggles write through the agent grants routes.
  app.get("/:secretId/agents", async (c) => {
    const auth = c.get("auth");
    return c.json(
      await getSecretAgentAccess(
        {
          workspaceId: requireWorkspaceId(auth),
          organizationId: auth.organizationId,
        },
        c.req.param("secretId"),
      ),
    );
  });

  // PATCH /secrets/:secretId
  app.patch("/:secretId", async (c) => {
    const auth = c.get("auth");
    const secretId = c.req.param("secretId");
    const body = await c.req.json().catch(() => null);
    const parsed = updateSecretSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    await updateSecret(
      { workspaceId: requireWorkspaceId(auth) },
      secretId,
      parsed.data,
    );
    invalidateGatewayCache(c.req.raw);
    return c.json({ success: true });
  });

  // DELETE /secrets/:secretId
  app.delete("/:secretId", async (c) => {
    const auth = c.get("auth");
    const secretId = c.req.param("secretId");
    await deleteSecret({ workspaceId: requireWorkspaceId(auth) }, secretId);
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  return app;
};
