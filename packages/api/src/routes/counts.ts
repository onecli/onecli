import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware } from "../middleware/auth";
import { getGatewayCounts } from "../services/counts-service";

export const countsRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.get("/", async (c) => {
    const auth = c.get("auth");
    const counts = await getGatewayCounts(auth.projectId);
    return c.json(counts);
  });

  return app;
};
