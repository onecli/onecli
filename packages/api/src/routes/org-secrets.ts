import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { auth } from "../middleware/auth";
import { getResourceHooks } from "../providers";
import {
  listSecrets,
  createSecret,
  updateSecret,
  deleteSecret,
} from "../services/secret-service";
import { createSecretSchema, updateSecretSchema } from "../validations/secret";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";

// Org secrets are admin/owner-only — every route requires admin.
const admin = auth({ requireWorkspace: false, role: "admin" });

export const orgSecretRoutes = () => {
  const app = new Hono<ApiEnv>();

  app.get("/", admin, async (c) => {
    const authCtx = c.get("auth");
    const secrets = await listSecrets({
      organizationId: authCtx.organizationId,
    });
    return c.json(secrets);
  });

  app.post("/", admin, async (c) => {
    const authCtx = c.get("auth");
    // Plan quota rides the provider seam (cloud enforces, self-host no-op) —
    // the same hook the workspace secrets route uses.
    await getResourceHooks().beforeCreateSecret(authCtx.organizationId);

    const body = await c.req.json().catch(() => null);
    const parsed = createSecretSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const secret = await withAudit(
      () =>
        createSecret({ organizationId: authCtx.organizationId }, parsed.data),
      (s) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.SECRET,
        source: AUDIT_SOURCE.API,
        metadata: {
          secretId: s.id,
          name: parsed.data.name,
          scope: "organization",
        },
      }),
    );
    return c.json(secret, 201);
  });

  app.patch("/:secretId", admin, async (c) => {
    const authCtx = c.get("auth");
    const secretId = c.req.param("secretId");
    const body = await c.req.json().catch(() => null);
    const parsed = updateSecretSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    await withAudit(
      () =>
        updateSecret(
          { organizationId: authCtx.organizationId },
          secretId,
          parsed.data,
        ),
      () => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.SECRET,
        source: AUDIT_SOURCE.API,
        metadata: { secretId, scope: "organization" },
      }),
    );
    return c.json({ success: true });
  });

  app.delete("/:secretId", admin, async (c) => {
    const authCtx = c.get("auth");
    const secretId = c.req.param("secretId");
    await withAudit(
      () => deleteSecret({ organizationId: authCtx.organizationId }, secretId),
      () => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.SECRET,
        source: AUDIT_SOURCE.API,
        metadata: { secretId, scope: "organization" },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
