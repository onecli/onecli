import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware } from "../middleware/auth";
import { invalidateGatewayCache } from "../lib/gateway-invalidate";
import {
  listAgents,
  createAgent,
  getDefaultAgent,
  renameAgent,
  deleteAgent,
  regenerateAgentToken,
  updateAgentSecretMode,
  getAgentSecrets,
  updateAgentSecrets,
} from "../services/agent-service";
import {
  createAgentSchema,
  renameAgentSchema,
  secretModeSchema,
  updateAgentSecretsSchema,
} from "../validations/agent";

export const agentRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /agents
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const agents = await listAgents(auth.projectId);
    return c.json(agents);
  });

  // POST /agents
  app.post("/", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = createAgentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const agent = await createAgent(
      auth.projectId,
      parsed.data.name,
      parsed.data.identifier,
    );
    invalidateGatewayCache(c.req.raw);
    return c.json(agent, 201);
  });

  // GET /agents/default
  app.get("/default", async (c) => {
    const auth = c.get("auth");
    const agent = await getDefaultAgent(auth.projectId);
    if (!agent) {
      return c.json({ error: "No default agent found" }, 404);
    }
    return c.json(agent);
  });

  // PATCH /agents/:agentId
  app.patch("/:agentId", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const body = await c.req.json().catch(() => null);
    const parsed = renameAgentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    await renameAgent(auth.projectId, agentId, parsed.data.name);
    return c.json({ success: true });
  });

  // DELETE /agents/:agentId
  app.delete("/:agentId", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    await deleteAgent(auth.projectId, agentId);
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  // POST /agents/:agentId/regenerate-token
  app.post("/:agentId/regenerate-token", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const result = await regenerateAgentToken(auth.projectId, agentId);
    invalidateGatewayCache(c.req.raw);
    return c.json(result);
  });

  // PATCH /agents/:agentId/secret-mode
  app.patch("/:agentId/secret-mode", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const body = await c.req.json().catch(() => null);
    const parsed = secretModeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    await updateAgentSecretMode(auth.projectId, agentId, parsed.data.mode);
    invalidateGatewayCache(c.req.raw);
    return c.json({ success: true });
  });

  // GET /agents/:agentId/secrets
  app.get("/:agentId/secrets", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const secretIds = await getAgentSecrets(auth.projectId, agentId);
    return c.json(secretIds);
  });

  // PUT /agents/:agentId/secrets
  app.put("/:agentId/secrets", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const body = await c.req.json().catch(() => null);
    const parsed = updateAgentSecretsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    await updateAgentSecrets(auth.projectId, agentId, parsed.data.secretIds);
    invalidateGatewayCache(c.req.raw);
    return c.json({ success: true });
  });

  return app;
};
