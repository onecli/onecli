import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import { getUser, updateProfile } from "../services/user-service";
import { ensureApiKey, regenerateApiKey } from "../services/api-key-service";
import {
  recordAuditEvent,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";
import { updateProfileSchema } from "../validations/user";

export const userRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /user
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const user = await getUser(auth.userId);
    return c.json(user);
  });

  // PATCH /user
  app.patch("/", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = updateProfileSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const user = await updateProfile(auth.userId, parsed.data.name);
    return c.json(user);
  });

  // GET /user/api-key
  app.get("/api-key", async (c) => {
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);
    const { apiKey, created } = await ensureApiKey(auth.userId, { projectId });
    if (created) {
      await recordAuditEvent({
        projectId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.API_KEY,
        source: AUDIT_SOURCE.API,
        metadata: { scope: "project", autoProvisioned: true },
      });
    }
    return c.json({ apiKey });
  });

  // POST /user/api-key/regenerate
  app.post("/api-key/regenerate", async (c) => {
    const auth = c.get("auth");
    const result = await regenerateApiKey(auth.userId, {
      projectId: requireProjectId(auth),
    });
    return c.json(result);
  });

  return app;
};
