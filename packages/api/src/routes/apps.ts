import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { authMiddleware, requireProjectId, auth } from "../middleware/auth";
import { getApp, getApps } from "../apps/registry";
import {
  getAppPermissionDefinition,
  getAppPermissionDefinitions,
  toAppPermissionDefinitionSummary,
} from "../apps/app-permissions";
import { resolveAppCredentials } from "../apps/resolve-credentials";
import {
  resolveConnectCredentials,
  type ConnectRequestBody,
} from "../apps/connect-credentials";
import { getOAuthOrg, getOrgAppConfig } from "../providers";
import {
  signOAuthState,
  verifyOAuthState,
  generateNonce,
} from "../lib/oauth-state";
import { APP_URL, NODE_ENV } from "../lib/env";
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
  linkConnectionToAppConfig,
  listConnectionsByProvider,
  extractLabel,
} from "../services/connection-service";
import {
  disconnectOwnedConnection,
  renameOwnedConnection,
} from "./connections";
import { getConnectionHooks } from "../providers";
import {
  getAppConfig,
  upsertAppConfig,
  deleteAppConfig,
  saveAppConfigWithoutDisconnect,
  toggleAppConfigEnabled,
  listConfiguredProviders,
} from "../services/app-config-service";
import { parseConfigBody } from "../validations/app-config";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";
import {
  initBlocklistDefaults,
  getBlocklistState,
  toggleBlocklistRule,
  activateBlocklistHost,
  addCustomBlocklistRule,
  removeBlocklistRule,
} from "../services/app-blocklist-service";
import { logger } from "../lib/logger";

const docsBaseURL = "https://onecli.sh/docs/guides/credential-stubs";

const toggleSchema = z.object({ enabled: z.boolean() });

export const appRoutes = () => {
  const app = new Hono<ApiEnv>();

  // ── GET /apps ── list all apps ─────────────────────────────────────────
  app.get("/", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);

    // EE (orgAppConfig seam): org-level configs surface on apps that have no
    // project row, marked `source: "organization"`. OSS: no seam — empty map.
    const [configs, connections, orgConfigsResult] = await Promise.all([
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
      getOrgAppConfig()?.listEnabledConfigs(auth.organizationId),
    ]);
    const orgConfigs = orgConfigsResult ?? {};

    const configMap = new Map(configs.map((cfg) => [cfg.provider, cfg]));

    const connectionMap = new Map(
      connections.map((conn) => [conn.provider, conn]),
    );
    const connectionsByProvider = new Map<string, typeof connections>();
    for (const conn of connections) {
      const list = connectionsByProvider.get(conn.provider) ?? [];
      list.push(conn);
      connectionsByProvider.set(conn.provider, list);
    }

    const result = getApps().map((a) => {
      const config = configMap.get(a.id);
      const orgConfig = orgConfigs[a.id];
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
          : orgConfig
            ? {
                hasCredentials: orgConfig.hasCredentials,
                enabled: true,
                source: "organization",
              }
            : null,
        // Deprecated: first connection only — misleading for multi-account
        // providers. Kept verbatim for deployed CLIs; use `connections`.
        connection: connection
          ? {
              status: connection.status,
              scopes: connection.scopes,
              connectedAt: connection.connectedAt,
            }
          : null,
        connections: (connectionsByProvider.get(a.id) ?? []).map((conn) => ({
          id: conn.id,
          label: conn.label,
          status: conn.status,
          scopes: conn.scopes,
          connectedAt: conn.connectedAt,
        })),
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
  // Legacy alias of DELETE /v1/connections/:connectionId — same core, kept
  // for deployed CLIs. Remove once all clients (CLI ≥ next release) migrate.
  app.delete("/connections/:connectionId", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const connectionId = c.req.param("connectionId");
    const deleted = await disconnectOwnedConnection(auth, connectionId);
    if (!deleted) {
      return c.json({ error: "Connection not found" }, 404);
    }
    return c.body(null, 204);
  });

  // ── PATCH /apps/connections/:connectionId ── rename ─────────────────────
  // Legacy alias of PATCH /v1/connections/:connectionId — same core.
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

    const updated = await renameOwnedConnection(auth, connectionId, label);
    if (!updated) {
      return c.json({ error: "Connection not found" }, 404);
    }
    return c.json(updated);
  });

  // ── GET /apps/configured ── providers with an enabled app config ───────
  // Registered before GET /:provider so the static path isn't swallowed by
  // the param route.
  app.get("/configured", authMiddleware, async (c) => {
    const auth = c.get("auth");
    // EE (orgAppConfig seam): org-level configs count as configured for every
    // project in the org. OSS: no seam — project rows only, as before.
    const [providers, orgConfigs] = await Promise.all([
      listConfiguredProviders({ projectId: requireProjectId(auth) }),
      getOrgAppConfig()?.listEnabledConfigs(auth.organizationId),
    ]);
    if (!orgConfigs) return c.json(providers);
    return c.json([...new Set([...providers, ...Object.keys(orgConfigs)])]);
  });

  // ── GET /apps/env-defaults ── providers with platform default creds ────
  // Reports this API process's env — the same env resolveAppCredentials
  // reads during the OAuth flows.
  app.get("/env-defaults", auth({ requireProject: false }), async (c) => {
    const providers = getApps()
      .filter((appDef) => {
        const envDefaults = appDef.configurable?.envDefaults;
        if (!envDefaults) return false;
        return Object.values(envDefaults).every(
          (envVar) => !!process.env[envVar],
        );
      })
      .map((appDef) => appDef.id);
    return c.json(providers);
  });

  // ── GET /apps/permission-definitions ── tool catalogs (all providers) ──
  // Public projection only (id/name/description per tool); the endpoint
  // mapping never leaves the server. Registered before the /:provider param
  // routes; filtered through getApp so editions that register a permission
  // definition without its app (e.g. onprem's aws-role) don't advertise it.
  app.get(
    "/permission-definitions",
    auth({ requireProject: false }),
    async (c) => {
      const definitions = getAppPermissionDefinitions()
        .filter((def) => getApp(def.provider))
        .map(toAppPermissionDefinitionSummary);
      return c.json(definitions);
    },
  );

  // ── GET /apps/:provider ── single app detail ───────────────────────────
  app.get("/:provider", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);
    if (!appDef) {
      return c.json({ error: `Unknown provider: ${provider}` }, 404);
    }

    const [config, providerConnections] = await Promise.all([
      getAppConfig({ projectId }, provider),
      db.appConnection.findMany({
        where: { projectId, provider },
        select: {
          id: true,
          label: true,
          status: true,
          scopes: true,
          connectedAt: true,
        },
        orderBy: { connectedAt: "desc" },
      }),
    ]);
    const connection = providerConnections[0] ?? null;

    // EE (orgAppConfig seam): an org-level config stands in when the project
    // has no row of its own (inventory-faithful: a project row, even disabled,
    // is shown as-is). OSS: no seam — always null.
    const orgConfig = config
      ? null
      : ((await getOrgAppConfig()?.getEnabledConfig(
          auth.organizationId,
          provider,
        )) ?? null);

    const isConfigured =
      (config !== null && config.hasCredentials) ||
      orgConfig !== null ||
      connection !== null;

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
        : orgConfig
          ? {
              hasCredentials: orgConfig.hasCredentials,
              enabled: true,
              source: "organization",
            }
          : null,
      // Deprecated: latest connection only — misleading for multi-account
      // providers. Kept verbatim for deployed CLIs; use `connections`.
      connection: connection
        ? {
            status: connection.status,
            scopes: connection.scopes,
            connectedAt: connection.connectedAt,
          }
        : null,
      connections: providerConnections,
      credentialStubs: appDef.credentialStubs ?? [],
      hint,
    });
  });

  // ── GET /apps/:provider/authorize ── OAuth redirect ────────────────────
  app.get(
    "/:provider/authorize",
    auth({ requireProject: false }),
    async (c) => {
      const provider = c.req.param("provider")!;
      const auth = c.get("auth");

      const orgResponse = await getOAuthOrg().tryHandleOrgAuthorize(
        auth,
        c,
        provider,
      );
      if (orgResponse) return orgResponse;

      // Fail loud: an explicit org context with no wired org handler must not
      // silently fall through to a project-scoped connection.
      if (c.req.query("_org")) {
        return c.json(
          {
            error:
              "Organization-scoped connections are not supported on this server",
          },
          400,
        );
      }

      const projectId = requireProjectId(auth);
      const appDef = getApp(provider);

      if (
        !appDef ||
        !appDef.available ||
        appDef.connectionMethod.type !== "oauth"
      ) {
        return c.json(
          { error: `Provider "${provider}" is not available` },
          400,
        );
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

      const resolved = await resolveAppCredentials(
        projectId,
        appDef,
        auth.organizationId,
      );
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
    },
  );

  // ── GET /apps/:provider/callback ── OAuth callback ─────────────────────
  app.get("/:provider/callback", async (c) => {
    const provider = c.req.param("provider")!;
    const apiOrigin = getRequestOrigin(c.req.raw);
    const appOrigin = APP_URL || apiOrigin;

    const appDef = getApp(provider);
    if (
      appDef?.connectionMethod.type === "oauth" &&
      appDef.connectionMethod.fragmentCallback &&
      !c.req.query(appDef.connectionMethod.fragmentCallback.paramName)
    ) {
      const errorUrl = `${appOrigin}/app-connect/${provider}?status=error&message=${encodeURIComponent("No token received")}`;
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
        `${appOrigin}/app-connect/${provider}?status=error&message=${encodeURIComponent(msg)}`,
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
            `${appOrigin}/app-connect/${provider}?${successParams}`,
          );
        }
      }

      const resolved = await resolveAppCredentials(
        state.projectId,
        appDef,
        stateOrgId,
      );
      if (!resolved) {
        return errorRedirect(`${appDef.name} is not configured`);
      }

      const redirectUri = `${apiOrigin}/v1/apps/${provider}/callback`;

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
            appConfigId: resolved.appConfigId,
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
            appConfigId: resolved.appConfigId,
          },
        );
      }

      if (appDef.blocklist?.length) {
        await initBlocklistDefaults(
          { projectId: state.projectId },
          provider,
          appDef.blocklist,
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

      return c.redirect(
        `${appOrigin}/app-connect/${provider}?${successParams}`,
      );
    } catch (err) {
      logger.error({ err, provider }, "OAuth callback failed");
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred";
      return errorRedirect(message);
    }
  });

  // ── POST /apps/:provider/connect ── direct connect ─────────────────────
  app.post("/:provider/connect", auth({ requireProject: false }), async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);

    if (!appDef || !appDef.available) {
      return c.json({ error: `Provider "${provider}" is not available` }, 400);
    }

    const body = (await c.req
      .json()
      .catch(() => null)) as ConnectRequestBody | null;

    const resolved = await resolveConnectCredentials(provider, appDef, body);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 400);
    }
    const { credentials, scopes, metadata, activeMethod, fields } = resolved;

    const connectionOpts = {
      scopes,
      metadata,
      label: body?.label?.trim() || undefined,
    };

    const orgResponse = await getOAuthOrg().tryHandleOrgConnect(
      auth,
      c.req.raw,
      provider,
      credentials,
      connectionOpts,
      body?.connectionId,
      fields,
    );
    if (orgResponse) return orgResponse;

    // Fail loud: the caller explicitly asked for an org-scoped connection but
    // no org handler is wired on this server — reject instead of silently
    // creating a project-scoped connection.
    if (c.req.header("x-organization-id")) {
      return c.json(
        {
          error:
            "Organization-scoped connections are not supported on this server",
        },
        400,
      );
    }

    const projectId = requireProjectId(auth);
    await getConnectionHooks().beforeConnect(auth.organizationId, appDef);

    // Project-scoped connect starts with no config link — body-provided
    // credentials have no minting config. The credentials-import branch below
    // re-links to the project config it saves; the explicit `undefined` also
    // clears any stale link when reconnecting an existing connection.
    const projectConnectionOpts = { ...connectionOpts, appConfigId: undefined };

    let connection: { id: string };

    if (body?.connectionId) {
      connection = await reconnectConnection(
        { projectId },
        body.connectionId,
        credentials,
        projectConnectionOpts,
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
        connection = await reconnectConnection(
          { projectId },
          duplicate.id,
          credentials,
          projectConnectionOpts,
        );
      } else {
        await getConnectionHooks().beforeCreate(auth.organizationId);
        connection = await createConnection(
          { projectId },
          provider,
          credentials,
          projectConnectionOpts,
        );
      }
    }

    if (appDef.blocklist?.length) {
      await initBlocklistDefaults({ projectId }, provider, appDef.blocklist);
    }

    if (
      activeMethod.type === "credentials_import" &&
      !fields.privateKey &&
      fields.clientId &&
      fields.clientSecret
    ) {
      const savedConfig = await saveAppConfigWithoutDisconnect(
        { projectId },
        provider,
        fields.clientId,
        fields.clientSecret,
      );
      // This connection was imported alongside its own project config — record
      // that provenance so config removal/refresh can find it.
      await linkConnectionToAppConfig(
        { projectId },
        connection.id,
        savedConfig.id,
      );
    }

    invalidateGatewayCache(c.req.raw);

    return c.json({ success: true });
  });

  // ── GET /apps/:provider/permission-definition ── tool catalog ──────────
  // The static permission catalog (groups + toolIds) that
  // GET/PUT /rules/permissions/:provider operate on. Global data — no project
  // context required, so org-key callers work without X-Project-Id.
  app.get(
    "/:provider/permission-definition",
    auth({ requireProject: false }),
    async (c) => {
      const provider = c.req.param("provider")!;
      if (!getApp(provider)) {
        return c.json({ error: `Unknown provider: ${provider}` }, 404);
      }
      const def = getAppPermissionDefinition(provider);
      if (!def) {
        return c.json(
          { error: `No permission definition for provider: ${provider}` },
          404,
        );
      }
      return c.json(toAppPermissionDefinitionSummary(def));
    },
  );

  // ── GET /apps/:provider/config ── get app config ───────────────────────
  app.get("/:provider/config", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;
    const config = await getAppConfig(
      { projectId: requireProjectId(auth) },
      provider,
    );
    if (config?.enabled) return c.json(config);

    // EE (orgAppConfig seam): no enabled project row — report the org-level
    // config as configured, marked `source: "organization"` so the project
    // config form knows there is no project row to edit. Org settings are
    // deliberately not exposed on the project surface.
    const orgConfig = await getOrgAppConfig()?.getEnabledConfig(
      auth.organizationId,
      provider,
    );
    if (orgConfig) {
      return c.json({
        hasCredentials: orgConfig.hasCredentials,
        enabled: true,
        source: "organization",
      });
    }

    return c.json(config ?? { hasCredentials: false, enabled: false });
  });

  // ── POST /apps/:provider/config ── upsert app config ──────────────────
  app.post("/:provider/config", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;

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

    const projectId = requireProjectId(auth);
    await withAudit(
      () =>
        upsertAppConfig(
          { projectId },
          provider,
          values,
          appDef.configurable!.fields,
        ),
      () => ({
        projectId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.APP_CONFIG,
        source: AUDIT_SOURCE.API,
        metadata: { provider },
      }),
    );

    return c.json({ success: true }, 201);
  });

  // ── DELETE /apps/:provider/config ── delete app config ─────────────────
  app.delete("/:provider/config", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;
    const projectId = requireProjectId(auth);
    await withAudit(
      () => deleteAppConfig({ projectId }, provider),
      () => ({
        projectId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.APP_CONFIG,
        source: AUDIT_SOURCE.API,
        metadata: { provider },
      }),
    );
    return c.body(null, 204);
  });

  // ── PATCH /apps/:provider/config/toggle ── enable/disable app config ───
  app.patch("/:provider/config/toggle", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;
    const body = await c.req.json().catch(() => null);
    const parsed = toggleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    const projectId = requireProjectId(auth);
    await withAudit(
      () =>
        toggleAppConfigEnabled({ projectId }, provider, parsed.data.enabled),
      () => ({
        projectId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.APP_CONFIG,
        source: AUDIT_SOURCE.API,
        metadata: { provider, enabled: parsed.data.enabled },
      }),
    );
    return c.json({ success: true });
  });

  // ── GET /apps/:provider/blocklist ── list blocklist state ─────────────
  app.get("/:provider/blocklist", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);
    if (!appDef) return c.json({ error: "Unknown provider" }, 404);

    const states = await getBlocklistState(
      { projectId, organizationId: auth.organizationId },
      provider,
      appDef.blocklist ?? [],
    );
    return c.json(states);
  });

  // ── POST /apps/:provider/blocklist ── activate predefined or add custom ─
  app.post("/:provider/blocklist", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);
    if (!appDef) return c.json({ error: "Unknown provider" }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid request body" }, 400);

    let result;
    if (body.hostId) {
      result = await activateBlocklistHost(
        { projectId },
        provider,
        body.hostId,
        appDef.blocklist ?? [],
      );
    } else if (body.name && body.hostPattern) {
      result = await addCustomBlocklistRule(
        { projectId },
        provider,
        body.name,
        body.hostPattern,
      );
    } else {
      return c.json(
        { error: "Provide either { hostId } or { name, hostPattern }" },
        400,
      );
    }

    invalidateGatewayCache(c.req.raw);
    return c.json(result, 201);
  });

  // ── PATCH /apps/:provider/blocklist/:ruleId ── toggle enabled ─────────
  app.patch("/:provider/blocklist/:ruleId", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);
    const ruleId = c.req.param("ruleId")!;

    const body = await c.req.json().catch(() => null);
    if (body?.enabled === undefined)
      return c.json({ error: "enabled is required" }, 400);

    await toggleBlocklistRule({ projectId }, ruleId, body.enabled);
    invalidateGatewayCache(c.req.raw);
    return c.json({ success: true });
  });

  // ── DELETE /apps/:provider/blocklist/:ruleId ── remove blocklist rule ──
  app.delete("/:provider/blocklist/:ruleId", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const projectId = requireProjectId(auth);
    const ruleId = c.req.param("ruleId")!;

    await removeBlocklistRule({ projectId }, ruleId);
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  return app;
};
