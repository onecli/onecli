import { createMiddleware } from "hono/factory";
import { validateApiKey } from "../lib/validate-api-key";
import { getSessionProvider } from "../providers";
import type { ApiEnv } from "../types";
import { db } from "@onecli/db";
import { findUserDefaultProject } from "../services/organization-service";

export const authMiddleware = createMiddleware<ApiEnv>(async (c, next) => {
  const apiKeyAuth = await validateApiKey(c.req.raw);
  if (apiKeyAuth) {
    c.set("auth", apiKeyAuth);
    return next();
  }

  const session = getSessionProvider();
  const user = await session.getSession(c.req.raw);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const dbUser = await db.user.findUnique({
    where: { externalAuthId: user.id },
    select: { id: true },
  });
  if (!dbUser) return c.json({ error: "Unauthorized" }, 401);

  const projectId = await session.resolveProjectForUser(dbUser.id, c.req.raw);
  if (!projectId) {
    const fallback = await findUserDefaultProject(dbUser.id);
    if (!fallback) return c.json({ error: "Unauthorized" }, 401);
    c.set("auth", { userId: dbUser.id, projectId: fallback.id });
    return next();
  }

  c.set("auth", { userId: dbUser.id, projectId });
  return next();
});
