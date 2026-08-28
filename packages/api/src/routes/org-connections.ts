import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { auth } from "../middleware/auth";
import {
  listConnections,
  listConnectionsByProvider,
  deleteConnection,
  updateConnectionLabel,
} from "../services/connection-service";
import { removeAllBlocklistRules } from "../services/app-blocklist-service";
import { getApp } from "../apps/registry";
import { db } from "@onecli/db";
import { invalidateGatewayCacheForOrg } from "../lib/gateway-invalidate";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";

// Org connections are admin/owner-only.
const admin = auth({ requireWorkspace: false, role: "admin" });

/**
 * Org connections as a top-level resource. Mounted twice: canonically at
 * /v1/org/connections, and at /connections inside /v1/org/apps so the legacy
 * /v1/org/apps/connections* paths keep working for deployed CLIs — one
 * router, zero drift. GET /:provider is itself legacy (ancient CLIs called
 * /v1/org/connections/:provider); new callers filter with ?provider=.
 */
export const orgConnectionRoutes = () => {
  const app = new Hono<ApiEnv>();

  // ── GET /org/connections?provider= ── list org connections ─────────────
  app.get("/", admin, async (c) => {
    const authCtx = c.get("auth");
    const provider = c.req.query("provider");
    const connections = provider
      ? await listConnectionsByProvider(
          { organizationId: authCtx.organizationId },
          provider,
        )
      : await listConnections({ organizationId: authCtx.organizationId });
    return c.json(connections);
  });

  // Legacy filter-in-path variant — kept for deployed CLIs.
  app.get("/:provider", admin, async (c) => {
    const authCtx = c.get("auth");
    const provider = c.req.param("provider");
    const connections = await listConnectionsByProvider(
      { organizationId: authCtx.organizationId },
      provider,
    );
    return c.json(connections);
  });

  app.delete("/:connectionId", admin, async (c) => {
    const authCtx = c.get("auth");
    const connectionId = c.req.param("connectionId");
    const organizationId = authCtx.organizationId;

    const conn = await db.appConnection.findFirst({
      where: { id: connectionId, organizationId, scope: "organization" },
      select: { provider: true },
    });

    await withAudit(
      () => deleteConnection({ organizationId }, connectionId),
      () => ({
        organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.DISCONNECT,
        service: AUDIT_SERVICES.APP_CONNECTION,
        source: AUDIT_SOURCE.API,
        metadata: { connectionId, scope: "organization" },
      }),
    );

    if (conn) {
      const remaining = await listConnectionsByProvider(
        { organizationId },
        conn.provider,
      );
      if (remaining.length === 0) {
        await removeAllBlocklistRules(
          { organizationId },
          conn.provider,
          getApp(conn.provider)?.blocklist ?? [],
        );
        // withAudit's flush ran before the blocklist cleanup — flush once
        // more so removed deny-rules can't linger in the gateway cache.
        invalidateGatewayCacheForOrg(organizationId);
      }
    }

    return c.body(null, 204);
  });

  app.patch("/:connectionId", admin, async (c) => {
    const authCtx = c.get("auth");
    const connectionId = c.req.param("connectionId");
    const organizationId = authCtx.organizationId;

    const body = (await c.req.json().catch(() => null)) as {
      label?: string;
    } | null;
    const label = body?.label?.trim();
    if (!label) {
      return c.json({ error: "Label is required" }, 400);
    }

    const updated = await withAudit(
      () => updateConnectionLabel({ organizationId }, connectionId, label),
      () => ({
        organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.APP_CONNECTION,
        source: AUDIT_SOURCE.API,
        metadata: { connectionId, scope: "organization" },
      }),
    );
    return c.json(updated);
  });

  return app;
};
