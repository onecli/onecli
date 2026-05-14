import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware } from "../middleware/auth";
import { invalidateGatewayCache } from "../lib/gateway-invalidate";
import {
  listSecrets,
  createSecret,
  updateSecret,
  deleteSecret,
} from "../services/secret-service";
import { createSecretSchema, updateSecretSchema } from "../validations/secret";

export const secretRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /secrets
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const secrets = await listSecrets(auth.projectId);
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

    const secret = await createSecret(auth.projectId, parsed.data);
    invalidateGatewayCache(c.req.raw);
    return c.json(secret, 201);
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

    await updateSecret(auth.projectId, secretId, parsed.data);
    invalidateGatewayCache(c.req.raw);
    return c.json({ success: true });
  });

  // DELETE /secrets/:secretId
  app.delete("/:secretId", async (c) => {
    const auth = c.get("auth");
    const secretId = c.req.param("secretId");
    await deleteSecret(auth.projectId, secretId);
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  return app;
};
