import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware } from "../middleware/auth";
import { getUser, updateProfile } from "../services/user-service";
import { getApiKey, regenerateApiKey } from "../services/api-key-service";
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
    const result = await getApiKey(auth.userId, auth.projectId);
    return c.json(result);
  });

  // POST /user/api-key/regenerate
  app.post("/api-key/regenerate", async (c) => {
    const auth = c.get("auth");
    const result = await regenerateApiKey(auth.userId, auth.projectId);
    return c.json(result);
  });

  return app;
};
