import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware } from "../middleware/auth";
import { GATEWAY_SKILL } from "../lib/skills/gateway-skill";

export const skillRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /skill/gateway
  app.get("/gateway", (c) =>
    c.body(GATEWAY_SKILL, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
    }),
  );

  return app;
};
