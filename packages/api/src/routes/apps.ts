import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import { getApp, getApps } from "../apps/registry";
import { resolveAppCredentials } from "../apps/resolve-credentials";
import { getOAuthOrg } from "../providers";
import {
  signOAuthState,
  verifyOAuthState,
  generateNonce,
} from "../lib/oauth-state";
import { NODE_ENV } from "../lib/env";
import { dashboardUrl } from "../lib/dashboard-url";
import { getRequestOrigin } from "../lib/request-origin";
import { buildFragmentBridgeHtml } from "../lib/fragment-bridge";
import {
  invalidateGatewayCache,
  invalidateGatewayCacheForAccount,
} from "../lib/gateway-invalidate";
import {
  listConnections,
  createConnection,
  reconnectConnection,
  listConnectionsByProvider,
  extractLabel,
  deleteConnection,
  updateConnectionLabel,
} from "../services/connection-service";
import { getConnectionHooks } from "../providers";
import {
  getAppConfig,
  upsertAppConfig,
  deleteAppConfig,
  saveAppConfigWithoutDisconnect,
} from "../services/app-config-service";
import { configBodySchema } from "../validations/app-config";
import { logger } from "../lib/logger";

const docsBaseURL = "https://onecli.sh/docs/guides/credential-stubs";

export const appRoutes = () => {
  const app = new Hono<ApiEnv>();

  // ── GET /apps ── list all apps ─────────────────────────────────────────
  app.get("/", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);

    const [configs, connections] = await Promise.all([
      db.appConfig.findMany({
        where: { projectId },
        select: {
          provider: true,
          enabled: true,
          credentials: true,
          createdAt: true,
        },
      }),
      listConnections({ projectId }),
    ]);

    const configMap = new Map(configs.map((cfg) => [cfg.provider, cfg]));
    const connectionMap = new Map(
      connections.map((conn) => [conn.provider, conn]),
    );

    const result = getApps().map((a) => {
      const config = configMap.get(a.id);
      const connection = connectionMap.get(a.id);

      return {
        id: a.id,
        name: a.name,
        available: a.available,
        connectionType: a.connectionMethod.type,
        configurable: !!a.configurable,
        config: config
          ? {
              hasCredentials: !!config.credentials,
              enabled: config.enabled,
            }
          : null,
        connection: connection
          ? {
              status: connection.status,
              scopes: connection.scopes,
              connectedAt: connection.connectedAt,
            }
          : null,
        credentialStubs: a.credentialStubs ?? [],
      };
    });

    return c.json(result);
  });

  // ── GET /apps/connections ── list all connections ───────────────────────
  app.get("/connections", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const connections = await listConnections({
      projectId: requireProjectId(auth),
      organizationId: auth.organizationId,
    });
    return c.json({ connections });
  });

  // ── GET /apps/connections/:provider ── list connections by provider ────
  app.get("/connections/:provider", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider");
    const connections = await listConnectionsByProvider(
      {
        projectId: requireProjectId(auth),
        organizationId: auth.organizationId,
      },
      provider,
    );
    return c.json({ connections });
  });

  // ── DELETE /apps/connections/:connectionId ── disconnect ───────────────
  app.delete("/connections/:connectionId", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.param("connectionId");
    const connection = await db.appConnection.findFirst({
      where: {
        id: connectionId,
        OR: [
          { projectId: requireProjectId(auth) },
          ...(auth.organizationId
            ? [{ organizationId: auth.organizationId }]
            : []),
        ],
      },
      select: { scope: true },
    });
    if (!connection) {
      return c.json({ error: "Connection not found" }, 404);
    }
    const scope =
      connection.scope === "organization"
        ? { organizationId: auth.organizationId }
        : { projectId: requireProjectId(auth) };
    await deleteConnection(scope, connectionId);
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  // ── PATCH /apps/connections/:connectionId ── rename ─────────────────────
  app.patch("/connections/:connectionId", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.param("connectionId");

    const body = (await c.req.json().catch(() => null)) as {
      label?: string;
    } | null;
    const label = body?.label?.trim();
    if (!label) {
      return c.json({ error: "Label is required" }, 400);
    }

    const connection = await db.appConnection.findFirst({
      where: {
        id: connectionId,
        OR: [
          { projectId: requireProjectId(auth) },
          ...(auth.organizationId
            ? [{ organizationId: auth.organizationId }]
            : []),
        ],
      },
      select: { scope: true },
    });
    if (!connection) {
      return c.json({ error: "Connection not found" }, 404);
    }

    const scope =
      connection.scope === "organization"
        ? { organizationId: auth.organizationId }
        : { projectId: requireProjectId(auth) };

    const updated = await updateConnectionLabel(scope, connectionId, label);
    return c.json(updated);
  });

  // ── GET /apps/:provider ── single app detail ───────────────────────────
  app.get("/:provider", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);
    if (!appDef) {
      return c.json({ error: `Unknown provider: ${provider}` }, 404);
    }

    const [config, connection] = await Promise.all([
      getAppConfig({ projectId }, provider),
      db.appConnection.findFirst({
        where: { projectId, provider },
        select: {
          status: true,
          scopes: true,
          connectedAt: true,
        },
        orderBy: { connectedAt: "desc" },
      }),
    ]);

    const isConfigured =
      (config !== null && config.hasCredentials) || connection !== null;

    const hint = isConfigured
      ? `Your MCP server needs local credential stub files to start. Create them in the format and location the MCP server expects, but use 'onecli-managed' as a placeholder for all secrets. See ${docsBaseURL}/${provider}.md for examples (fallback: ${docsBaseURL}/general-app.md ). The OneCLI gateway handles real OAuth token exchange at request time.`
      : `This app is not configured yet. Go to ${dashboardUrl(`/connections?connect=${provider}`, { projectId })} to set up your credentials.`;

    return c.json({
      id: appDef.id,
      name: appDef.name,
      available: appDef.available,
      connectionType: appDef.connectionMethod.type,
      configurable: !!appDef.configurable,
      config: config
        ? {
            hasCredentials: config.hasCredentials,
            enabled: config.enabled,
          }
        : null,
      connection: connection
        ? {
            status: connection.status,
            scopes: connection.scopes,
            connectedAt: connection.connectedAt,
          }
        : null,
      credentialStubs: appDef.credentialStubs ?? [],
      hint,
    });
  });

  // ── GET /apps/:provider/authorize ── OAuth redirect ────────────────────
  app.get("/:provider/authorize", authMiddleware, async (c) => {
    const provider = c.req.param("provider")!;
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);

    const orgResponse = await getOAuthOrg().tryHandleOrgAuthorize(
      auth,
      c,
      provider,
    );
    if (orgResponse) return orgResponse;
    const appDef = getApp(provider);

    if (
      !appDef ||
      !appDef.available ||
      appDef.connectionMethod.type !== "oauth"
    ) {
      return c.json({ error: `Provider "${provider}" is not available` }, 400);
    }

    const connectionId = c.req.query("connectionId");
    const rawAgentName = c.req.query("agent_name");
    const agentName = rawAgentName ? rawAgentName.slice(0, 128) : undefined;

    const state = signOAuthState({
      projectId,
      provider,
      nonce: generateNonce(),
      ...(connectionId ? { connectionId } : {}),
      ...(agentName ? { agentName } : {}),
    });

    const resolved = await resolveAppCredentials(projectId, appDef);
    if (!resolved) {
      return c.json(
        {
          error: `${appDef.name} is not configured. Missing required credentials.`,
        },
        400,
      );
    }

    const { values: creds } = resolved;

    const redirectUri = `${getRequestOrigin(c.req.raw)}/v1/apps/${provider}/callback`;
    const scopes = appDef.connectionMethod.defaultScopes ?? [];

    const authUrl = appDef.connectionMethod.buildAuthUrl({
      appCredentials: creds,
      redirectUri,
      scopes,
      state,
    });

    setCookie(c, "oauth_state", state, {
      httpOnly: true,
      secure: NODE_ENV === "production",
      sameSite: "Lax",
      path: `/v1/apps/${provider}/callback`,
      maxAge: 600,
    });

    return c.redirect(authUrl);
  });

  // ── GET /apps/:provider/callback ── OAuth callback ─────────────────────
  app.get("/:provider/callback", async (c) => {
    const provider = c.req.param("provider")!;
    const origin = getRequestOrigin(c.req.raw);

    const appDef = getApp(provider);
    if (
      appDef?.connectionMethod.type === "oauth" &&
      appDef.connectionMethod.fragmentCallback &&
      !c.req.query(appDef.connectionMethod.fragmentCallback.paramName)
    ) {
      const errorUrl = `${origin}/app-connect/${provider}?status=error&message=${encodeURIComponent("No token received")}`;
      return c.html(
        buildFragmentBridgeHtml(
          appDef.connectionMethod.fragmentCallback.paramName,
          errorUrl,
        ),
      );
    }

    const orgResponse = await getOAuthOrg().tryHandleOrgCallback(
      c.req.raw,
      provider,
    );
    if (orgResponse) return orgResponse;

    const errorRedirect = (msg: string) =>
      c.redirect(
        `${origin}/app-connect/${provider}?status=error&message=${encodeURIComponent(msg)}`,
      );

    try {
      const appDef = getApp(provider);

      if (!appDef || appDef.connectionMethod.type !== "oauth") {
        return errorRedirect("Invalid provider");
      }

      const stateParam = c.req.query("state") ?? getCookie(c, "oauth_state");
      if (!stateParam) {
        return errorRedirect("Missing state parameter");
      }

      const state = verifyOAuthState(stateParam);
      if (!state || state.provider !== provider) {
        return errorRedirect("Invalid state parameter");
      }

      if (!state.projectId) {
        return errorRedirect("Missing project in state");
      }

      const stateProject = await db.project.findUnique({
        where: { id: state.projectId },
        select: { organizationId: true },
      });
      if (!stateProject) return errorRedirect("Project not found");
      const stateOrgId = stateProject.organizationId;

      // Microsoft can send duplicate callbacks -- the first with a valid code
      // (which succeeds) and the second with error=server_error. If a
      // connection was created moments ago during this same OAuth flow,
      // treat the error callback as a no-op and redirect to success.
      if (c.req.query("error")) {
        const recentCutoff = new Date(Date.now() - 30_000);
        const existing = await listConnectionsByProvider(
          { projectId: state.projectId },
          provider,
        );
        const justCreated = existing.some(
          (conn) =>
            conn.status === "connected" && conn.connectedAt >= recentCutoff,
        );
        if (justCreated) {
          const successParams = new URLSearchParams({ status: "success" });
          if (state.agentName) {
            successParams.set("agent_name", state.agentName as string);
          }
          return c.redirect(
            `${origin}/app-connect/${provider}?${successParams}`,
          );
        }
      }

      const resolved = await resolveAppCredentials(state.projectId, appDef);
      if (!resolved) {
        return errorRedirect(`${appDef.name} is not configured`);
      }

      const redirectUri = `${origin}/v1/apps/${provider}/callback`;

      // Extract all query params as callback params
      const url = new URL(c.req.url);
      const callbackParams = Object.fromEntries(url.searchParams.entries());

      const result = await appDef.connectionMethod.exchangeCode({
        appCredentials: resolved.values,
        callbackParams,
        redirectUri,
      });

      const { credentials, scopes, metadata } = result;

      let reconnectId = state.connectionId as string | undefined;

      if (!reconnectId) {
        const identity = extractLabel(metadata)?.toLowerCase().trim();
        if (identity) {
          const existing = await listConnectionsByProvider(
            { projectId: state.projectId },
            provider,
          );
          const duplicate = existing.find(
            (conn) => conn.label?.toLowerCase().trim() === identity,
          );
          if (duplicate) reconnectId = duplicate.id;
        }
      }

      await getConnectionHooks().beforeConnect(stateOrgId, appDef);

      if (reconnectId) {
        await reconnectConnection(
          { projectId: state.projectId },
          reconnectId,
          credentials,
          {
            scopes,
            metadata,
          },
        );
      } else {
        await getConnectionHooks().beforeCreate(stateOrgId);
        await createConnection(
          { projectId: state.projectId },
          provider,
          credentials,
          {
            scopes,
            metadata,
          },
        );
      }

      invalidateGatewayCacheForAccount(state.projectId);

      const successParams = new URLSearchParams({ status: "success" });
      if (state.agentName) {
        successParams.set("agent_name", state.agentName as string);
      }

      deleteCookie(c, "oauth_state", {
        path: `/v1/apps/${provider}/callback`,
      });

      return c.redirect(`${origin}/app-connect/${provider}?${successParams}`);
    } catch (err) {
      logger.error({ err, provider }, "OAuth callback failed");
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred";
      return errorRedirect(message);
    }
  });

  // ── POST /apps/:provider/connect ── direct connect ─────────────────────
  app.post("/:provider/connect", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);

    if (!appDef || !appDef.available) {
      return c.json({ error: `Provider "${provider}" is not available` }, 400);
    }

    if (appDef.connectionMethod.type === "oauth") {
      return c.json(
        {
          error: `Provider "${provider}" uses OAuth flow, not direct credentials`,
        },
        400,
      );
    }

    if (appDef.connectionMethod.type === "cloud_only") {
      return c.json(
        { error: `Provider "${provider}" is only available in OneCLI Cloud` },
        400,
      );
    }

    const body = (await c.req.json().catch(() => null)) as {
      fields?: Record<string, string>;
      connectionId?: string;
      label?: string;
    } | null;
    if (!body?.fields) {
      return c.json({ error: "Missing fields in request body" }, 400);
    }

    const { fields } = body;

    let requiredFields: { name: string; label: string }[];
    if (
      appDef.connectionMethod.type === "credentials_import" &&
      appDef.connectionMethod.fields.some((f) => f.group)
    ) {
      requiredFields = appDef.connectionMethod.fields.filter((f) => {
        if (!f.group) return true;
        if (fields.privateKey) return f.group === "service_account";
        return f.group === "authorized_user";
      });
    } else {
      requiredFields = appDef.connectionMethod.fields.filter(
        (f) => !("optional" in f && f.optional),
      );
    }

    for (const field of requiredFields) {
      if (!fields[field.name]?.trim()) {
        return c.json({ error: `${field.label} is required` }, 400);
      }
    }

    let credentials: Record<string, unknown>;
    let scopes: string[] | undefined;
    let metadata: Record<string, unknown> | undefined;

    if (appDef.connectionMethod.type === "credentials_import") {
      const result = await appDef.connectionMethod.exchangeCredentials(fields);
      credentials = result.credentials;
      scopes = result.scopes;
      metadata = result.metadata;
    } else {
      const primaryField = appDef.connectionMethod.fields[0];
      credentials = {
        access_token: fields[primaryField!.name],
        ...fields,
      };

      if (appDef.connectionMethod.resolveMetadata) {
        metadata =
          (await appDef.connectionMethod.resolveMetadata(fields)) ?? undefined;
      }

      if (!metadata) {
        metadata = { name: "API Key" };
      }
    }

    const connectionOpts = {
      scopes,
      metadata,
      label: body.label?.trim() || undefined,
    };

    const orgResponse = await getOAuthOrg().tryHandleOrgConnect(
      auth,
      c.req.raw,
      provider,
      credentials,
      connectionOpts,
      body.connectionId,
      fields,
    );
    if (orgResponse) return orgResponse;

    await getConnectionHooks().beforeConnect(auth.organizationId, appDef);

    if (body.connectionId) {
      await reconnectConnection(
        { projectId },
        body.connectionId,
        credentials,
        connectionOpts,
      );
    } else {
      const existing = await listConnectionsByProvider({ projectId }, provider);
      const effectiveLabel =
        connectionOpts.label || extractLabel(metadata) || null;

      const duplicate = effectiveLabel
        ? existing.find(
            (conn) =>
              conn.label?.toLowerCase().trim() ===
              effectiveLabel.toLowerCase().trim(),
          )
        : existing[0];

      if (duplicate) {
        await reconnectConnection(
          { projectId },
          duplicate.id,
          credentials,
          connectionOpts,
        );
      } else {
        await getConnectionHooks().beforeCreate(auth.organizationId);
        await createConnection(
          { projectId },
          provider,
          credentials,
          connectionOpts,
        );
      }
    }

    if (
      appDef.connectionMethod.type === "credentials_import" &&
      !fields.privateKey &&
      fields.clientId &&
      fields.clientSecret
    ) {
      await saveAppConfigWithoutDisconnect(
        { projectId },
        provider,
        fields.clientId,
        fields.clientSecret,
      );
    }

    invalidateGatewayCache(c.req.raw);

    return c.json({ success: true });
  });

  // ── GET /apps/:provider/config ── get app config ───────────────────────
  app.get("/:provider/config", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;
    const config = await getAppConfig(
      { projectId: requireProjectId(auth) },
      provider,
    );

    return c.json(config ?? { hasCredentials: false, enabled: false });
  });

  // ── POST /apps/:provider/config ── upsert app config ──────────────────
  app.post("/:provider/config", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;

    const body = await c.req.json().catch(() => null);
    const parsed = configBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const appDef = getApp(provider);
    if (!appDef?.configurable) {
      return c.json(
        { error: `Provider "${provider}" does not support app configuration` },
        400,
      );
    }

    const { clientId, clientSecret } = parsed.data;
    await upsertAppConfig(
      { projectId: requireProjectId(auth) },
      provider,
      { clientId, clientSecret },
      appDef.configurable.fields,
    );

    invalidateGatewayCache(c.req.raw);

    return c.json({ success: true }, 201);
  });

  // ── DELETE /apps/:provider/config ── delete app config ─────────────────
  app.delete("/:provider/config", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;
    await deleteAppConfig({ projectId: requireProjectId(auth) }, provider);
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  return app;
};
