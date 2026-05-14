import { Hono } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../types";
import { authMiddleware } from "../middleware/auth";
import { IS_CLOUD } from "../lib/env";
import { exportToCloud } from "../services/migrate-export-service";
import { logger } from "../lib/logger";

const exportSchema = z.object({
  cloudApiKey: z.string().min(1, "Cloud API key is required"),
});

export const migrateRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // POST /migrate/export
  app.post("/export", async (c) => {
    if (IS_CLOUD) {
      return c.json({ error: "Not found" }, 404);
    }

    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = exportSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const result = await exportToCloud(auth.projectId, parsed.data.cloudApiKey);

    logger.info(
      { projectId: auth.projectId, imported: result.imported },
      "migration export completed",
    );

    return c.json(result);
  });

  return app;
};
