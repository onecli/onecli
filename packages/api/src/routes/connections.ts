import { Hono } from "hono";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import {
  listConnections,
  listConnectionsByProvider,
  deleteConnection,
  updateConnectionLabel,
} from "../services/connection-service";
import {
  listConnectionAgents,
  setConnectionAgents,
} from "../services/agent-service";
import { setConnectionAgentsSchema } from "../validations/agent";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";
import { removeAllBlocklistRules } from "../services/app-blocklist-service";
import {
  invalidateGatewayCacheForAccount,
  invalidateGatewayCacheForOrg,
} from "../lib/gateway-invalidate";

type Auth = ApiEnv["Variables"]["auth"];

// Ownership: a project-scoped row in the caller's project, or an org-scoped
// row in the caller's organization (project members may manage org rows via
// the project surface — longstanding behavior).
const findOwnedConnection = (auth: Auth, connectionId: string) =>
  db.appConnection.findFirst({
    where: {
      id: connectionId,
      OR: [
        { projectId: requireProjectId(auth) },
        ...(auth.organizationId
          ? [{ organizationId: auth.organizationId }]
          : []),
      ],
    },
    select: { scope: true, provider: true },
  });

/**
 * Disconnect flow shared by /v1/connections/:id and its legacy alias
 * /v1/apps/connections/:id — audit (auto-flushes), then blocklist cleanup
 * with a re-flush when the provider's last connection went away.
 * Returns false when the connection isn't owned by the caller (404).
 */
export const disconnectOwnedConnection = async (
  auth: Auth,
  connectionId: string,
): Promise<boolean> => {
  const connection = await findOwnedConnection(auth, connectionId);
  if (!connection) return false;

  const isOrg = connection.scope === "organization";
  const scope = isOrg
    ? { organizationId: auth.organizationId }
    : { projectId: requireProjectId(auth) };
  await withAudit(
    () => deleteConnection(scope, connectionId),
    () => ({
      ...(isOrg
        ? { organizationId: auth.organizationId }
        : { projectId: requireProjectId(auth) }),
      userId: auth.userId,
      userEmail: auth.userEmail,
      action: AUDIT_ACTIONS.DISCONNECT,
      service: AUDIT_SERVICES.APP_CONNECTION,
      source: AUDIT_SOURCE.API,
      metadata: isOrg
        ? { connectionId, scope: "organization" }
        : { connectionId },
    }),
  );

  const remaining = await listConnectionsByProvider(scope, connection.provider);
  if (remaining.length === 0) {
    await removeAllBlocklistRules(scope, connection.provider);
    // withAudit's flush ran before the blocklist cleanup — flush once more
    // so removed deny-rules can't linger in the gateway cache.
    if (isOrg) invalidateGatewayCacheForOrg(auth.organizationId);
    else invalidateGatewayCacheForAccount(requireProjectId(auth));
  }

  return true;
};

/**
 * Rename flow shared by /v1/connections/:id and its legacy alias.
 * Returns null when the connection isn't owned by the caller (404).
 */
export const renameOwnedConnection = async (
  auth: Auth,
  connectionId: string,
  label: string,
) => {
  const connection = await findOwnedConnection(auth, connectionId);
  if (!connection) return null;

  const isOrg = connection.scope === "organization";
  const scope = isOrg
    ? { organizationId: auth.organizationId }
    : { projectId: requireProjectId(auth) };

  return withAudit(
    () => updateConnectionLabel(scope, connectionId, label),
    () => ({
      ...(isOrg
        ? { organizationId: auth.organizationId }
        : { projectId: requireProjectId(auth) }),
      userId: auth.userId,
      userEmail: auth.userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.APP_CONNECTION,
      source: AUDIT_SOURCE.API,
      metadata: isOrg
        ? { connectionId, scope: "organization" }
        : { connectionId },
    }),
  );
};

// Connections as a top-level resource. The legacy /v1/apps/connections* paths
// remain as aliases (routes/apps.ts) sharing the cores above; unlike them,
// this surface filters via ?provider= (never the path — the single-segment
// GET slot stays reserved for get-by-id) and returns bare arrays.
export const connectionRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // ── GET /connections?provider= ── list connections ─────────────────────
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const provider = c.req.query("provider");
    const scope = {
      projectId: requireProjectId(auth),
      organizationId: auth.organizationId,
    };
    const connections = provider
      ? await listConnectionsByProvider(scope, provider)
      : await listConnections(scope);
    return c.json(connections);
  });

  // ── PATCH /connections/:connectionId ── rename ─────────────────────────
  app.patch("/:connectionId", async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.param("connectionId");

    const body = (await c.req.json().catch(() => null)) as {
      label?: string;
    } | null;
    const label = body?.label?.trim();
    if (!label) {
      return c.json({ error: "Label is required" }, 400);
    }

    const updated = await renameOwnedConnection(auth, connectionId, label);
    if (!updated) {
      return c.json({ error: "Connection not found" }, 404);
    }
    return c.json(updated);
  });

  // ── DELETE /connections/:connectionId ── disconnect ────────────────────
  app.delete("/:connectionId", async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.param("connectionId");
    const deleted = await disconnectOwnedConnection(auth, connectionId);
    if (!deleted) {
      return c.json({ error: "Connection not found" }, 404);
    }
    return c.body(null, 204);
  });

  // ── GET /connections/:connectionId/agents ── which project agents can ──
  // use this connection (reverse of GET /agents/:id/connections).
  app.get("/:connectionId/agents", async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.param("connectionId");
    const agents = await listConnectionAgents(
      requireProjectId(auth),
      connectionId,
    );
    return c.json(agents);
  });

  // ── PUT /connections/:connectionId/agents ── set the selective agents ──
  // granted this connection. All-mode agents already reach every connection
  // and are neither granted nor revoked here.
  app.put("/:connectionId/agents", async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.param("connectionId");

    const body = await c.req.json().catch(() => null);
    const parsed = setConnectionAgentsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const projectId = requireProjectId(auth);
    await withAudit(
      () => setConnectionAgents(projectId, connectionId, parsed.data.agentIds),
      (result) => ({
        projectId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.AGENT,
        source: AUDIT_SOURCE.API,
        metadata: {
          connectionId,
          added: result.added,
          removed: result.removed,
        },
      }),
    );
    return c.json({ success: true });
  });

  return app;
};
