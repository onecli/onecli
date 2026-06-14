import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import { invalidateGatewayCache } from "../lib/gateway-invalidate";
import {
  listAgents,
  createAgent,
  getDefaultAgent,
  setDefaultAgent,
  renameAgent,
  deleteAgent,
  regenerateAgentToken,
  updateAgentSecretMode,
  getAgentSecrets,
  updateAgentSecrets,
  getAgentAppConnections,
  updateAgentAppConnections,
  listAgentGranularAccess,
} from "../services/agent-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";
import {
  createAgentSchema,
  renameAgentSchema,
  secretModeSchema,
  updateAgentSecretsSchema,
  updateAgentConnectionsSchema,
} from "../validations/agent";
import { getResourceHooks } from "../providers";

export const agentRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /agents
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const agents = await listAgents(requireProjectId(auth));
    return c.json(agents);
  });

  // GET /agents/granular-access — read-only overview of per-agent granular
  // policies (GitHub repos, Dropbox folders) across the project.
  app.get("/granular-access", async (c) => {
    const auth = c.get("auth");
    const entries = await listAgentGranularAccess(requireProjectId(auth));
    return c.json(entries);
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

    await getResourceHooks().beforeCreateAgent(auth.organizationId);

    const agent = await createAgent(
      requireProjectId(auth),
      parsed.data.name,
      parsed.data.identifier,
      parsed.data.parentIdentifier,
    );
    invalidateGatewayCache(c.req.raw);
    return c.json(agent, 201);
  });

  // GET /agents/default
  app.get("/default", async (c) => {
    const auth = c.get("auth");
    const agent = await getDefaultAgent(requireProjectId(auth));
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

    await renameAgent(requireProjectId(auth), agentId, parsed.data.name);
    return c.json({ success: true });
  });

  // DELETE /agents/:agentId
  app.delete("/:agentId", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    await deleteAgent(requireProjectId(auth), agentId);
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  // POST /agents/:agentId/set-default
  app.post("/:agentId/set-default", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    await setDefaultAgent(requireProjectId(auth), agentId);
    invalidateGatewayCache(c.req.raw);
    return c.json({ success: true });
  });

  // POST /agents/:agentId/regenerate-token
  app.post("/:agentId/regenerate-token", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const result = await regenerateAgentToken(requireProjectId(auth), agentId);
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

    const projectId = requireProjectId(auth);
    await withAudit(
      () => updateAgentSecretMode(projectId, agentId, parsed.data.mode),
      () => ({
        projectId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.AGENT,
        source: AUDIT_SOURCE.API,
        metadata: { agentId, secretMode: parsed.data.mode },
      }),
    );
    return c.json({ success: true });
  });

  // GET /agents/:agentId/secrets
  app.get("/:agentId/secrets", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const secretIds = await getAgentSecrets(requireProjectId(auth), agentId);
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

    const projectId = requireProjectId(auth);
    await withAudit(
      () => updateAgentSecrets(projectId, agentId, parsed.data.secretIds),
      () => ({
        projectId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.AGENT,
        source: AUDIT_SOURCE.API,
        metadata: { agentId, secretCount: parsed.data.secretIds.length },
      }),
    );
    return c.json({ success: true });
  });

  // GET /agents/:agentId/connections
  app.get("/:agentId/connections", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const connections = await getAgentAppConnections(
      requireProjectId(auth),
      agentId,
    );
    return c.json(connections);
  });

  // PUT /agents/:agentId/connections — replace the agent's app-connection
  // assignments and their per-connection granular-access policies.
  app.put("/:agentId/connections", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const body = await c.req.json().catch(() => null);
    const parsed = updateAgentConnectionsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const projectId = requireProjectId(auth);
    await withAudit(
      () =>
        updateAgentAppConnections(projectId, agentId, parsed.data.connections),
      () => ({
        projectId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.AGENT,
        source: AUDIT_SOURCE.API,
        metadata: {
          agentId,
          appConnectionCount: parsed.data.connections.length,
        },
      }),
    );
    return c.json({ success: true });
  });

  return app;
};
