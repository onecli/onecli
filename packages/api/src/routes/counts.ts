import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { getResourceCounts } from "../services/counts-service";

export const countsRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.get("/", async (c) => {
    const auth = c.get("auth");
    const counts = await getResourceCounts(
      requireWorkspaceId(auth),
      auth.organizationId,
    );
    return c.json(counts);
  });

  return app;
};
