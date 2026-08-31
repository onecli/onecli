import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ApiEnv } from "../types";
import { auth } from "../middleware/auth";
import { getApp } from "../apps/registry";
import {
  resolveConnectCredentials,
  type ConnectRequestBody,
} from "../apps/connect-credentials";
import { orgAuthorize, orgConnect } from "../apps/oauth-org";
import { orgConnectionRoutes } from "./org-connections";
import {
  getAppConfig,
  upsertAppConfig,
  deleteAppConfig,
  toggleAppConfigEnabled,
  listConfiguredProviders,
  countAppConfigDependents,
} from "../services/app-config-service";
import {
  getBlocklistState,
  toggleBlocklistRule,
  activateBlocklistHost,
  removeBlocklistRule,
} from "../services/app-blocklist-service";
import { parseConfigBody } from "../validations/app-config";
import { ensureOrgAwsExternalId } from "../services/aws-external-id-service";
import { invalidateGatewayCache } from "../lib/gateway-invalidate";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";

const toggleSchema = z.object({ enabled: z.boolean() });

// Org app connections/config/blocklist are admin/owner-only — every route
// requires admin.
const admin = auth({ requireWorkspace: false, role: "admin" });

export const orgAppRoutes = () => {
  const app = new Hono<ApiEnv>();

  // ── Connections ──────────────────────────────────────────────────────
  // Legacy alias mount of /v1/org/connections (same router, zero drift) —
  // keeps /v1/org/apps/connections* working for deployed CLIs. Remove once
  // all clients (CLI ≥ next release) migrate.
  app.route("/connections", orgConnectionRoutes());

  // ── Connect ─────────────────────────────────────────────────────────
  // Canonical org-scoped connection creation. The same cores back the legacy
  // header/`_org` interceptors on /v1/apps/:provider/* (routes/apps.ts), so
  // both entry points stay byte-identical.

  app.get("/:provider/authorize", admin, async (c) => {
    const authCtx = c.get("auth");
    const provider = c.req.param("provider");
    // Multi-org sessions may target another org they belong to via ?org=
    // (a browser navigation can't carry headers); orgAuthorize
    // membership-checks whichever org is used.
    const orgId = c.req.query("org") ?? authCtx.organizationId;
    return orgAuthorize(authCtx, c, provider, orgId);
  });

  app.post("/:provider/connect", admin, async (c) => {
    const authCtx = c.get("auth");
    const provider = c.req.param("provider");
    const appDef = getApp(provider);
    if (!appDef) {
      return c.json({ error: `Provider "${provider}" is not available` }, 400);
    }

    const body = (await c.req
      .json()
      .catch(() => null)) as ConnectRequestBody | null;

    const resolved = await resolveConnectCredentials(
      provider,
      appDef,
      body,
      authCtx.organizationId,
    );
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 400);
    }

    return orgConnect(
      authCtx,
      provider,
      authCtx.organizationId,
      resolved.credentials,
      {
        scopes: resolved.scopes,
        metadata: resolved.metadata,
        label: body?.label?.trim() || undefined,
      },
      body?.connectionId,
      resolved.fields,
    );
  });

  // ── AWS external ID ─────────────────────────────────────────────────
  // The org's `sts:ExternalId`, for the AWS Role connect screen's trust-policy
  // step. Read from the membership-fenced auth context, so a caller can only
  // ever learn their OWN org's id; minted on first read and stable after.
  // Admin-only like every other route here — it names an org-level identity.
  //
  // A GET that may write on first call is deliberate and safe: the write is an
  // idempotent lazy initialization (conditional, and it never changes an
  // existing value), so the endpoint stays effectively idempotent for callers.
  app.get("/aws-external-id", admin, async (c) => {
    const authCtx = c.get("auth");
    const externalId = await ensureOrgAwsExternalId(authCtx.organizationId);
    return c.json({ externalId });
  });

  // ── Config ──────────────────────────────────────────────────────────

  app.get("/configured", admin, async (c) => {
    const authCtx = c.get("auth");
    const providers = await listConfiguredProviders({
      organizationId: authCtx.organizationId,
    });
    return c.json(providers);
  });

  app.get("/:provider/config", admin, async (c) => {
    const authCtx = c.get("auth");
    const provider = c.req.param("provider");
    const scope = { organizationId: authCtx.organizationId };
    const [config, dependents] = await Promise.all([
      getAppConfig(scope, provider),
      countAppConfigDependents(scope, provider),
    ]);
    return c.json({
      ...(config ?? { hasCredentials: false, enabled: false }),
      dependents,
    });
  });

  app.post("/:provider/config", admin, async (c) => {
    const authCtx = c.get("auth");
    const provider = c.req.param("provider");
    const appDef = getApp(provider);
    if (!appDef?.configurable) {
      return c.json(
        { error: `Provider "${provider}" does not support app configuration` },
        400,
      );
    }

    const body = await c.req.json().catch(() => null);
    const values = parseConfigBody(body, appDef.configurable.fields);
    if (!values) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    await withAudit(
      () =>
        upsertAppConfig(
          { organizationId: authCtx.organizationId },
          provider,
          values,
          appDef.configurable!.fields,
        ),
      () => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.APP_CONFIG,
        source: AUDIT_SOURCE.API,
        metadata: { provider, scope: "organization" },
      }),
    );
    return c.json({ success: true }, 201);
  });

  app.delete("/:provider/config", admin, async (c) => {
    const authCtx = c.get("auth");
    const provider = c.req.param("provider");
    await withAudit(
      () =>
        deleteAppConfig({ organizationId: authCtx.organizationId }, provider),
      () => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.APP_CONFIG,
        source: AUDIT_SOURCE.API,
        metadata: { provider, scope: "organization" },
      }),
    );
    return c.body(null, 204);
  });

  app.patch("/:provider/config/toggle", admin, async (c) => {
    const authCtx = c.get("auth");
    const provider = c.req.param("provider");
    const body = await c.req.json().catch(() => null);
    const parsed = toggleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    await withAudit(
      () =>
        toggleAppConfigEnabled(
          { organizationId: authCtx.organizationId },
          provider,
          parsed.data.enabled,
        ),
      () => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.APP_CONFIG,
        source: AUDIT_SOURCE.API,
        metadata: {
          provider,
          enabled: parsed.data.enabled,
          scope: "organization",
        },
      }),
    );
    return c.json({ success: true });
  });

  // ── Blocklist ───────────────────────────────────────────────────────

  app.get("/:provider/blocklist", admin, async (c) => {
    const { organizationId } = c.get("auth");
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);
    if (!appDef) return c.json({ error: "Unknown provider" }, 404);

    const states = await getBlocklistState(
      { organizationId },
      provider,
      appDef.blocklist ?? [],
    );
    return c.json(states);
  });

  app.post("/:provider/blocklist", admin, async (c) => {
    const { organizationId } = c.get("auth");
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);
    if (!appDef) return c.json({ error: "Unknown provider" }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid request body" }, 400);

    // Blocking an arbitrary host is a policy rule (POST /v1/org/policy/rules)
    // now; this surface only toggles the hosts the app itself declares.
    if (!body.hostId) {
      return c.json({ error: "Provide { hostId }" }, 400);
    }
    const result = await activateBlocklistHost(
      { organizationId },
      provider,
      body.hostId,
      appDef.blocklist ?? [],
    );

    invalidateGatewayCache(c.req.raw);
    return c.json(result, 201);
  });

  app.patch("/:provider/blocklist/:ruleId", admin, async (c) => {
    const { organizationId } = c.get("auth");
    const ruleId = c.req.param("ruleId")!;

    const body = await c.req.json().catch(() => null);
    if (body?.enabled === undefined)
      return c.json({ error: "enabled is required" }, 400);

    await toggleBlocklistRule({ organizationId }, ruleId, body.enabled);
    invalidateGatewayCache(c.req.raw);
    return c.json({ success: true });
  });

  app.delete("/:provider/blocklist/:ruleId", admin, async (c) => {
    const { organizationId } = c.get("auth");
    const ruleId = c.req.param("ruleId")!;

    await removeBlocklistRule({ organizationId }, ruleId);
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  return app;
};

/**
 * Legacy route aliases for backward compatibility.
 * Maps old paths to the new /org/apps/... structure.
 * Remove once all clients (CLI ≥ X.Y.Z) have migrated.
 */
export const orgAppRoutesLegacy = (root: Hono<ApiEnv>) => {
  const router = orgAppRoutes();

  const forward = (c: Context, path: string) =>
    router.fetch(new Request(new URL(path, c.req.url), c.req.raw), c.env);

  // /org/connections* is no longer aliased here — it's the canonical mount
  // of orgConnectionRoutes() (the free block in app.ts), which serves the
  // same handlers these aliases used to forward to.

  // /org/app-config/configured → /org/apps/configured
  root.all("/org/app-config/configured", (c) => forward(c, "/configured"));
  // /org/app-config/:provider → /org/apps/:provider/config
  root.all("/org/app-config/:provider", (c) =>
    forward(c, `/${c.req.param("provider")}/config`),
  );
  // /org/app-config/:provider/toggle → /org/apps/:provider/config/toggle
  root.all("/org/app-config/:provider/toggle", (c) =>
    forward(c, `/${c.req.param("provider")}/config/toggle`),
  );
};
