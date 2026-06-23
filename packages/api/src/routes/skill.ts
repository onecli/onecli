import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware } from "../middleware/auth";
import { getGatewaySkill } from "../lib/skills/gateway-skill";

export const skillRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /skill/gateway?agent_framework=<name>
  app.get("/gateway", (c) => {
    const agent = c.req.query("agent_framework")?.toLowerCase();
    return c.body(getGatewaySkill(agent), 200, {
      "Content-Type": "text/markdown; charset=utf-8",
    });
  });

  return app;
};
