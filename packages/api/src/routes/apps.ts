import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { authMiddleware } from "../middleware/auth";
import { getApp, getApps } from "../apps/registry";
import { resolveAppCredentials } from "../apps/resolve-credentials";
import { getOAuthOrg, getSelfUrl } from "../providers";
import {
  signOAuthState,
  verifyOAuthState,
  generateNonce,
} from "../lib/oauth-state";
import { APP_URL, NODE_ENV } from "../lib/env";
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
} from "../services/connection-service";
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

    const [configs, connections] = await Promise.all([
      db.appConfig.findMany({
        where: { projectId: auth.projectId },
        select: {
          provider: true,
          enabled: true,
          credentials: true,
          createdAt: true,
        },
      }),
      listConnections(auth.projectId),
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

  // ── GET /apps/:provider ── single app detail ───────────────────────────
  app.get("/:provider", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);
    if (!appDef) {
      return c.json({ error: `Unknown provider: ${provider}` }, 404);
    }

    const [config, connection] = await Promise.all([
      getAppConfig(auth.projectId, provider),
      db.appConnection.findFirst({
        where: { projectId: auth.projectId, provider },
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
      : `This app is not configured yet. Go to ${APP_URL}/connections?connect=${provider} to set up your credentials.`;

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
      projectId: auth.projectId,
      provider,
      nonce: generateNonce(),
      ...(connectionId ? { connectionId } : {}),
      ...(agentName ? { agentName } : {}),
    });

    const resolved = await resolveAppCredentials(auth.projectId, appDef);
    if (!resolved) {
      return c.json(
        {
          error: `${appDef.name} is not configured. Missing required credentials.`,
        },
        400,
      );
    }

    const { values: creds } = resolved;

    const redirectUri = `${getSelfUrl()}/v1/apps/${provider}/callback`;
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

    const orgResponse = await getOAuthOrg().tryHandleOrgCallback(
      c.req.raw,
      provider,
    );
    if (orgResponse) return orgResponse;

    const errorRedirect = (msg: string) =>
      c.redirect(
        `${APP_URL}/app-connect/${provider}?status=error&message=${encodeURIComponent(msg)}`,
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

      // Microsoft can send duplicate callbacks -- the first with a valid code
      // (which succeeds) and the second with error=server_error. If a
      // connection was created moments ago during this same OAuth flow,
      // treat the error callback as a no-op and redirect to success.
      if (c.req.query("error")) {
        const recentCutoff = new Date(Date.now() - 30_000);
        const existing = await listConnectionsByProvider(
          state.projectId,
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
            `${APP_URL}/app-connect/${provider}?${successParams}`,
          );
        }
      }

      const resolved = await resolveAppCredentials(state.projectId, appDef);
      if (!resolved) {
        return errorRedirect(`${appDef.name} is not configured`);
      }

      const redirectUri = `${getSelfUrl()}/v1/apps/${provider}/callback`;

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
            state.projectId,
            provider,
          );
          const duplicate = existing.find((conn) => {
            if (
              !conn.metadata ||
              typeof conn.metadata !== "object" ||
              Array.isArray(conn.metadata)
            )
              return false;
            const existingIdentity = extractLabel(
              conn.metadata as Record<string, unknown>,
            );
            return existingIdentity?.toLowerCase().trim() === identity;
          });
          if (duplicate) reconnectId = duplicate.id;
        }
      }

      if (reconnectId) {
        await reconnectConnection(state.projectId, reconnectId, credentials, {
          scopes,
          metadata,
        });
      } else {
        await createConnection(state.projectId, provider, credentials, {
          scopes,
          metadata,
        });
      }

      invalidateGatewayCacheForAccount(state.projectId);

      const successParams = new URLSearchParams({ status: "success" });
      if (state.agentName) {
        successParams.set("agent_name", state.agentName as string);
      }

      deleteCookie(c, "oauth_state", {
        path: `/v1/apps/${provider}/callback`,
      });

      return c.redirect(`${APP_URL}/app-connect/${provider}?${successParams}`);
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
      org?: boolean;
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

    const connectionOpts = { scopes, metadata };

    if (body.org) {
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
    }

    if (body.connectionId) {
      await reconnectConnection(
        auth.projectId,
        body.connectionId,
        credentials,
        connectionOpts,
      );
    } else {
      const existing = await listConnectionsByProvider(
        auth.projectId,
        provider,
      );
      const duplicate = metadata
        ? existing.find((conn) => {
            const label = extractLabel(
              conn.metadata as Record<string, unknown> | undefined,
            );
            const newLabel = extractLabel(metadata);
            return (
              label &&
              newLabel &&
              label.toLowerCase().trim() === newLabel.toLowerCase().trim()
            );
          })
        : existing[0];

      if (duplicate) {
        await reconnectConnection(
          auth.projectId,
          duplicate.id,
          credentials,
          connectionOpts,
        );
      } else {
        await createConnection(
          auth.projectId,
          provider,
          credentials,
          connectionOpts,
        );
      }
    }

    // For authorized_user credentials_import: persist client credentials as
    // BYOC AppConfig so the gateway can refresh tokens. Service accounts are
    // self-contained (private key stored in AppConnection) and skip this.
    if (
      appDef.connectionMethod.type === "credentials_import" &&
      !fields.privateKey &&
      fields.clientId &&
      fields.clientSecret
    ) {
      await saveAppConfigWithoutDisconnect(
        auth.projectId,
        provider,
        fields.clientId,
        fields.clientSecret,
      );
    }

    invalidateGatewayCache(c.req.raw);

    return c.json({ success: true });
  });

  // ── DELETE /apps/:provider/connection ── disconnect ─────────────────────
  app.delete("/:provider/connection", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.query("connectionId");

    if (!connectionId) {
      return c.json({ error: "connectionId query parameter is required" }, 400);
    }

    await deleteConnection(auth.projectId, connectionId);
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  // ── GET /apps/:provider/config ── get app config ───────────────────────
  app.get("/:provider/config", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;
    const config = await getAppConfig(auth.projectId, provider);

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
      auth.projectId,
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
    await deleteAppConfig(auth.projectId, provider);
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  return app;
};
