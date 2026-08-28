import { Hono } from "hono";
import { requireEnterprise } from "../middleware/enterprise-gate";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { assertFeatureAllowed } from "../services/quota-service";
import {
  createConnection,
  deleteConnection,
  listConnections,
  testConnection,
  updateConnection,
} from "../sso/sso-connection-service";
import {
  createSsoConnectionSchema,
  updateSsoConnectionSchema,
} from "../validations/sso-connection";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

// SSO connections are admin/owner-only. Creating and enabling are
// Enterprise-gated ("sso"); disabling, editing and deleting an existing
// connection never are — an org whose plan lapsed keeps its exit (mirrors
// enforcement, where only enabling is gated). GET stays readable so the
// settings page can render the locked state.
const admin = auth({ requireWorkspace: false, role: "admin" });

export const orgSsoConnectionRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("sso"));

  app.get("/", admin, async (c) => {
    const authCtx = c.get("auth");
    return c.json(await listConnections(authCtx.organizationId));
  });

  app.post("/", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "sso");

    const body = await c.req.json().catch(() => null);
    const parsed = createSsoConnectionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const connection = await withAudit(
      () =>
        createConnection(authCtx.organizationId, parsed.data, authCtx.userId),
      (conn) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.SSO_CONNECTION,
        source: AUDIT_SOURCE.API,
        metadata: {
          connectionId: conn.id,
          cognitoProviderName: conn.cognitoProviderName,
          type: conn.type,
        },
      }),
    );
    return c.json(connection, 201);
  });

  app.patch("/:connectionId", admin, async (c) => {
    const authCtx = c.get("auth");
    const connectionId = c.req.param("connectionId");

    const body = await c.req.json().catch(() => null);
    const parsed = updateSsoConnectionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    // Enabling recreates the Cognito IdP — that's acquiring the feature, so
    // it's Enterprise-gated. Everything else on an existing connection
    // (disable, rename, secret rotation) stays available on any plan.
    if (parsed.data.enabled === true) {
      await assertFeatureAllowed(authCtx.organizationId, "sso");
    }

    const connection = await withAudit(
      () => updateConnection(authCtx.organizationId, connectionId, parsed.data),
      (conn) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.SSO_CONNECTION,
        source: AUDIT_SOURCE.API,
        metadata: {
          connectionId: conn.id,
          cognitoProviderName: conn.cognitoProviderName,
          type: conn.type,
          // Enable/disable is security-relevant — record the transition.
          ...(parsed.data.enabled !== undefined
            ? { enabled: parsed.data.enabled }
            : {}),
        },
      }),
    );
    return c.json(connection);
  });

  // Deliberately not plan-gated: teardown must survive a plan lapse, or a
  // downgraded org is locked into SSO with no self-serve exit.
  app.delete("/:connectionId", admin, async (c) => {
    const authCtx = c.get("auth");
    const connectionId = c.req.param("connectionId");

    await withAudit(
      () => deleteConnection(authCtx.organizationId, connectionId),
      () => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.SSO_CONNECTION,
        source: AUDIT_SOURCE.API,
        metadata: { connectionId },
      }),
    );
    return c.body(null, 204);
  });

  // Validation-only: reachability + shape. No status change (the login
  // round-trip owns "active"), no audit (no mutation). Throttled per org —
  // each test fetches admin-supplied URLs.
  const testThrottle = rateLimit({
    name: "sso-test",
    limit: 10,
    windowSeconds: 60,
    key: (c) => c.get("auth").organizationId,
  });
  app.post("/:connectionId/test", admin, testThrottle, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "sso");
    const connectionId = c.req.param("connectionId");
    return c.json(await testConnection(authCtx.organizationId, connectionId));
  });

  return app;
};
