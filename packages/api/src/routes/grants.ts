import { Hono } from "hono";
import type { ApiEnv } from "../types";
import type { AuthContext } from "../providers";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { ServiceError } from "../services/errors";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";
import {
  connectionGrantSchema,
  type ConnectionGrantInput,
} from "../validations/grants";
import {
  getAgentGrants,
  getConnectionGrants,
  removeConnectionGrant,
  removeSecretGrant,
  setConnectionGrant,
  setSecretGrant,
  type GrantScope,
} from "../services/grants-service";

// ── The attach-model grants surface (plans/project-attach-model.md §4.3) ────
// Workspace scope only — org policy stays the rules surface. Two orientations
// over the same service: the agent side (the step-3 tabs) composes onto
// /v1/agents, the connection side (the step-4 dialog) onto /v1/connections,
// following the policy-reflect mount pattern. Every mutation wraps withAudit,
// which also flushes the gateway cache server-side — grants change what the
// gateway injects and decides, so the flush is load-bearing.

const grantScope = (auth: AuthContext): GrantScope => ({
  workspaceId: requireWorkspaceId(auth),
  organizationId: auth.organizationId,
});

const auditBase = (auth: AuthContext) => ({
  workspaceId: requireWorkspaceId(auth),
  userId: auth.userId,
  userEmail: auth.userEmail,
  service: AUDIT_SERVICES.GRANT,
  source: AUDIT_SOURCE.API,
});

const parseGrantBody = async (c: { req: { json: () => Promise<unknown> } }) => {
  const body = await c.req.json().catch(() => null);
  const parsed = connectionGrantSchema.safeParse(body);
  if (!parsed.success) {
    throw new ServiceError(
      "UNPROCESSABLE",
      parsed.error.issues[0]?.message ?? "Invalid grant body",
    );
  }
  return parsed.data;
};

/** Audit marker for the grant's resources tri-state — never the values
 * themselves (repo/folder names stay out of the audit log). */
const resourcesAudit = (
  input: ConnectionGrantInput,
): "preserved" | "cleared" | "set" =>
  input.resources === undefined
    ? "preserved"
    : input.resources === null
      ? "cleared"
      : "set";

export const agentGrantsRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /agents/:agentId/grants — the agent's attach intent (read-only, no audit).
  app.get("/:agentId/grants", async (c) => {
    const auth = c.get("auth");
    return c.json(
      await getAgentGrants(grantScope(auth), c.req.param("agentId")),
    );
  });

  // PUT /agents/:agentId/grants/connections/:connectionId — attach or rewrite.
  app.put("/:agentId/grants/connections/:connectionId", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const connectionId = c.req.param("connectionId");
    const input = await parseGrantBody(c);
    const result = await withAudit(
      () =>
        setConnectionGrant(
          grantScope(auth),
          agentId,
          connectionId,
          input,
          auth.userId,
        ),
      (r) => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: {
          agentId,
          connectionId,
          access: input.access,
          resources: resourcesAudit(input),
          changed: r.changed,
          ruleIds: r.ruleIds,
        },
      }),
    );
    return c.json(result.grants);
  });

  // DELETE /agents/:agentId/grants/connections/:connectionId — detach.
  app.delete("/:agentId/grants/connections/:connectionId", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const connectionId = c.req.param("connectionId");
    await withAudit(
      () =>
        removeConnectionGrant(
          grantScope(auth),
          agentId,
          connectionId,
          auth.userId,
        ),
      (r) => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.DELETE,
        metadata: { agentId, connectionId, changed: r.changed },
      }),
    );
    return c.body(null, 204);
  });

  // PUT /agents/:agentId/grants/secrets/:secretId — attach (assign-only).
  app.put("/:agentId/grants/secrets/:secretId", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const secretId = c.req.param("secretId");
    const result = await withAudit(
      () => setSecretGrant(grantScope(auth), agentId, secretId, auth.userId),
      (r) => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: { agentId, secretId, changed: r.changed, ruleIds: r.ruleIds },
      }),
    );
    return c.json(result.grants);
  });

  // DELETE /agents/:agentId/grants/secrets/:secretId — detach.
  app.delete("/:agentId/grants/secrets/:secretId", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const secretId = c.req.param("secretId");
    await withAudit(
      () => removeSecretGrant(grantScope(auth), agentId, secretId, auth.userId),
      (r) => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.DELETE,
        metadata: { agentId, secretId, changed: r.changed },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};

export const connectionGrantsRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /connections/:connectionId/grants — per-agent attach intent (reverse).
  app.get("/:connectionId/grants", async (c) => {
    const auth = c.get("auth");
    return c.json(
      await getConnectionGrants(grantScope(auth), c.req.param("connectionId")),
    );
  });

  // PUT /connections/:connectionId/grants/agents/:agentId — the dialog's toggle.
  app.put("/:connectionId/grants/agents/:agentId", async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.param("connectionId");
    const agentId = c.req.param("agentId");
    const input = await parseGrantBody(c);
    const result = await withAudit(
      () =>
        setConnectionGrant(
          grantScope(auth),
          agentId,
          connectionId,
          input,
          auth.userId,
        ),
      (r) => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.UPDATE,
        metadata: {
          agentId,
          connectionId,
          access: input.access,
          resources: resourcesAudit(input),
          changed: r.changed,
          ruleIds: r.ruleIds,
        },
      }),
    );
    return c.json(result.grants);
  });

  // DELETE /connections/:connectionId/grants/agents/:agentId — detach.
  app.delete("/:connectionId/grants/agents/:agentId", async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.param("connectionId");
    const agentId = c.req.param("agentId");
    await withAudit(
      () =>
        removeConnectionGrant(
          grantScope(auth),
          agentId,
          connectionId,
          auth.userId,
        ),
      (r) => ({
        ...auditBase(auth),
        action: AUDIT_ACTIONS.DELETE,
        metadata: { agentId, connectionId, changed: r.changed },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
