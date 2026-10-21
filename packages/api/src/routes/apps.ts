import { Hono, type Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId, auth } from "../middleware/auth";
import { hasActiveMembership } from "../middleware/auth/resolve";
import { getApp, getApps } from "../apps/registry";
import { accessLevelFromState, resolveAccessLevel } from "../apps/access-level";
import {
  appCallbackPath,
  authorizeScopesFor,
  configKeysFor,
  groupMembers,
  groupOf,
  isOAuthClientGroupId,
  redirectPathFor,
  signedRedirectPath,
  vendorCallbackPath,
} from "../apps/oauth/groups";
import type { AppDefinition } from "../apps/types";
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
import { getOAuthOrg, getOrgAppConfig, getAppAvailability } from "../providers";
import {
  signOAuthState,
  verifyOAuthState,
  generateNonce,
  OAUTH_STATE_COOKIE,
  oauthStateCookieOptions,
  type OAuthStatePayload,
} from "../lib/oauth-state";
import { dashboardUrl } from "../lib/dashboard-url";
import {
  getApiCallbackOrigin,
  getAppOrigin,
  getRequestOrigin,
} from "../lib/request-origin";
import { buildFragmentBridgeHtml } from "../lib/fragment-bridge";
import {
  invalidateGatewayCache,
  invalidateGatewayCacheForAccount,
} from "../lib/gateway-invalidate";
import { extractLabel } from "../lib/connection-display";
import {
  listConnections,
  createConnection,
  reconnectConnection,
  linkConnectionToAppConfig,
  listConnectionsByProvider,
} from "../services/connection-service";
import { connectGitHubInstallation } from "../services/github-installation-connect-service";
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
  removeBlocklistRule,
} from "../services/app-blocklist-service";
import { logger } from "../lib/logger";
import { setPartialGrantParams } from "../apps/missing-permissions";
import {
  grantConnectingAgent,
  resolveConnectingAgent,
} from "../services/agent-connect-grant-service";
import { registerGitHubAppShareRoutes } from "./github-app-share";

const docsBaseURL = "https://onecli.sh/docs/guides/credential-stubs";

const toggleSchema = z.object({ enabled: z.boolean() });

// Saving, removing, or toggling a workspace's OAuth client config overrides
// the org's client for every app of that vendor in the workspace (and
// disconnects their accounts), so it is admin/owner-only. Reads stay open to
// members.
const configAdmin = auth({ role: "admin" });

export const appRoutes = () => {
  const app = new Hono<ApiEnv>();

  // ── GET /apps ── list all apps ─────────────────────────────────────────
  app.get("/", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);

    // Org tier (orgAppConfig seam, boot-injected on every edition): org-level
    // configs surface on apps that have no workspace row, marked `source: "organization"`.
    const [configs, connections, orgConfigsResult] = await Promise.all([
      db.appConfig.findMany({
        where: { workspaceId },
        select: {
          provider: true,
          enabled: true,
          credentials: true,
          createdAt: true,
        },
      }),
      listConnections({ workspaceId }),
      getOrgAppConfig()?.listEnabledConfigs(auth.organizationId),
    ]);
    const orgConfigs = orgConfigsResult ?? {};

    const configMap = new Map(configs.map((cfg) => [cfg.provider, cfg]));
    // A workspace's vendor group row ("google") configures each member app
    // that has no legacy per-app row of its own.
    const workspaceConfigFor = (app: AppDefinition) => {
      for (const key of configKeysFor(app)) {
        const cfg = configMap.get(key);
        if (cfg) return cfg;
      }
      return undefined;
    };

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
      const config = workspaceConfigFor(a);
      const orgConfig = orgConfigs[a.id];
      const connection = connectionMap.get(a.id);

      return {
        id: a.id,
        name: a.name,
        // Deprecated wire field: always true since apps became universal —
        // kept because older CLIs read a missing field as false.
        available: true,
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
          missingPermissions: conn.missingPermissions,
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
      workspaceId: requireWorkspaceId(auth),
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
        workspaceId: requireWorkspaceId(auth),
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
    // Org tier (orgAppConfig seam): org-level configs count as configured for every
    // workspace in the org.
    const [providers, orgConfigs] = await Promise.all([
      listConfiguredProviders({ workspaceId: requireWorkspaceId(auth) }),
      getOrgAppConfig()?.listEnabledConfigs(auth.organizationId),
    ]);
    if (!orgConfigs) return c.json(providers);
    return c.json([...new Set([...providers, ...Object.keys(orgConfigs)])]);
  });

  // ── GET /apps/available ── app-availability allowlist for this workspace ──
  // Backs the connect-picker filter (policy-engine step 7). `restricted:false`
  // (no availability provider — self-host — or an "open" org) means every app is available and the
  // picker is unfiltered; `restricted:true` carries the exact provider set a
  // workspace may connect, mirroring the gateway's runtime availability read.
  // Registered before /:provider so "available" is not captured as a provider.
  app.get("/available", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const providers = await getAppAvailability()?.getAvailableProviders(
      workspaceId,
      auth.organizationId,
    );
    // `undefined` (no availability provider — self-host) and `null` (org in "open" mode) both mean
    // unrestricted — never leak an empty allowlist as "nothing available".
    return c.json(
      providers == null
        ? { restricted: false, providers: [] as string[] }
        : { restricted: true, providers },
    );
  });

  // ── GET /apps/env-defaults ── providers with platform default creds ────
  // Reports this API process's env — the same env resolveAppCredentials
  // reads during the OAuth flows.
  app.get("/env-defaults", auth({ requireWorkspace: false }), async (c) => {
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
  // routes; filtered through getApp so an edition that registers a permission
  // definition without its app doesn't advertise it.
  app.get(
    "/permission-definitions",
    auth({ requireWorkspace: false }),
    async (c) => {
      const definitions = getAppPermissionDefinitions()
        .filter((def) => getApp(def.provider))
        .map(toAppPermissionDefinitionSummary);
      return c.json(definitions);
    },
  );

  // ── /apps/github-app/… ── shared GitHub App installations ──────────────
  // Before GET /:provider so the static segments aren't swallowed.
  registerGitHubAppShareRoutes(app, authMiddleware, "workspace");

  // ── GET /apps/:provider ── single app detail ───────────────────────────
  app.get("/:provider", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);
    if (!appDef) {
      return c.json({ error: `Unknown provider: ${provider}` }, 404);
    }

    const [config, providerConnections] = await Promise.all([
      getAppConfig({ workspaceId }, provider),
      db.appConnection.findMany({
        where: { workspaceId, provider },
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

    // Org tier (orgAppConfig seam): an org-level config stands in when the workspace
    // has no row of its own (inventory-faithful: a workspace row, even disabled,
    // is shown as-is).
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
      : // The caller's origin is the fallback so an unconfigured self-hosted
        // instance hands out a link that actually resolves for them, rather
        // than the localhost default nobody but a local dev can open.
        `This app is not configured yet. Go to ${dashboardUrl(
          `/connections?connect=${provider}`,
          { workspaceId },
          getRequestOrigin(c.req.raw),
        )} to set up your credentials.`;

    return c.json({
      id: appDef.id,
      name: appDef.name,
      // Deprecated wire field: always true since apps became universal —
      // kept because older CLIs read a missing field as false.
      available: true,
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
    auth({ requireWorkspace: false }),
    async (c) => {
      const provider = c.req.param("provider")!;
      const auth = c.get("auth");
      // The agent this connect started from (its Connections section, the
      // chat, an agent's connect link): a created or re-added connection is
      // switched on for it. Resolved here, at the authenticated end and
      // before any org interceptor, so an org connect naming one is refused
      // like every other door, and the id the state signs is already fenced.
      const rawAgentId = c.req.query("agent_id");
      if (c.req.query("_org") && rawAgentId) {
        await resolveConnectingAgent(null, rawAgentId);
      }

      const orgResponse = await getOAuthOrg().tryHandleOrgAuthorize(
        auth,
        c,
        provider,
      );
      if (orgResponse) return orgResponse;

      // Fail loud: an explicit org context with no wired org handler must not
      // silently fall through to a workspace-scoped connection.
      if (c.req.query("_org")) {
        return c.json(
          {
            error:
              "Organization-scoped connections are not supported on this server",
          },
          400,
        );
      }

      const workspaceId = requireWorkspaceId(auth);
      const appDef = getApp(provider);

      if (!appDef || appDef.connectionMethod.type !== "oauth") {
        return c.json(
          { error: `Provider "${provider}" is not available` },
          400,
        );
      }

      const connectionId = c.req.query("connectionId");
      const rawAgentName = c.req.query("agent_name");
      const agentName = rawAgentName ? rawAgentName.slice(0, 128) : undefined;
      const agentId = await resolveConnectingAgent(workspaceId, rawAgentId);

      const accessLevel = resolveAccessLevel(
        appDef.connectionMethod,
        c.req.query("access_level"),
      );
      if (!accessLevel.ok) {
        return c.json({ error: accessLevel.error }, 400);
      }

      const resolved = await resolveAppCredentials(
        workspaceId,
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
      // A vendor-shared client (e.g. the org's Google client) uses the vendor's
      // single redirect URI; platform and per-app clients keep the per-app one.
      const redirectPath = redirectPathFor(provider, resolved.configKey);

      // Decide where the browser goes *after* consent here, at the authenticated
      // end, and sign it: the callback is unauthenticated, so re-deriving it
      // there from request headers lets the caller influence the destination.
      const state = signOAuthState({
        workspaceId,
        provider,
        nonce: generateNonce(),
        origin: getAppOrigin(c.req.raw),
        // The token exchange must send the exact redirect_uri used here.
        redirectPath,
        ...(connectionId ? { connectionId } : {}),
        ...(agentName ? { agentName } : {}),
        ...(agentId ? { agentId } : {}),
        // The token level the provider is asked for. Signed so the callback
        // exchanges the code the same way the consent screen issued it.
        ...(accessLevel.value ? { accessLevel: accessLevel.value } : {}),
        // Who started the connect: the callback is unauthenticated, so this is
        // the only way the grant it makes for the connecting agent can be
        // attributed in the audit log. Signed with the rest of the state, so
        // not forgeable.
        ...(auth.userId ? { userId: auth.userId } : {}),
      });

      const redirectUri = `${getApiCallbackOrigin(c.req.raw)}${redirectPath}`;
      const scopes = authorizeScopesFor(appDef, resolved.configKey);

      const authUrl = await appDef.connectionMethod.buildAuthUrl({
        appCredentials: creds,
        redirectUri,
        scopes,
        state,
        ...(accessLevel.value ? { accessLevel: accessLevel.value } : {}),
      });

      setCookie(
        c,
        OAUTH_STATE_COOKIE,
        state,
        oauthStateCookieOptions(redirectPath),
      );

      return c.redirect(authUrl);
    },
  );

  // ── OAuth callback core ── shared by the per-app and per-vendor routes ──
  // Each route resolved the state once (query, else the `oauth_state` cookie
  // `/authorize` set on this exact path) and checked it was minted for this
  // path; the core reuses that, never re-reading it.
  const handleOAuthCallback = async (
    c: Context<ApiEnv>,
    provider: string,
    stateParam: string | undefined,
    state: OAuthStatePayload | null,
  ) => {
    const apiOrigin = getApiCallbackOrigin(c.req.raw);

    // The state is resolved before anything else can redirect or render. The
    // cookie (SameSite=Lax, so the provider's top-level GET still carries it)
    // is why the fragment-bridge branch below can rely on it even though its
    // provider returns everything else in the URL fragment. That branch
    // renders the origin inside a <script>, so it is the last place that should
    // be trusting request headers.
    // Only a state this request would actually accept gets to choose the
    // destination — never one we are about to reject as belonging to another
    // provider.
    const signedOrigin =
      state?.provider === provider ? state.origin : undefined;

    // Two different questions, and conflating them is what broke this before.
    // `apiOrigin` is this deployment's api-server origin — it must build the
    // redirect_uri for the token exchange below, resolved exactly as
    // `/authorize` resolved it. `appOrigin` is where the browser goes next,
    // which is a dashboard page and may live on another host entirely, so it
    // comes from the origin committed to at `/authorize` rather than from this
    // unauthenticated request's headers. A state minted before that field
    // existed leaves it undefined and resolves exactly as it did before.
    const appOrigin = getAppOrigin(c.req.raw, signedOrigin);

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

      // Both resolved at the top so `appOrigin` could be derived from the state;
      // the checks stay here so the error responses are unchanged.
      if (!stateParam) {
        // A GitHub App "Redirect on update" with no connect in flight: the
        // user changed the installation's repos on GitHub itself. Nothing to
        // connect or store, just tell the popup it was saved.
        if (c.req.query("setup_action") === "update") {
          return c.redirect(
            `${appOrigin}/app-connect/${provider}?status=updated`,
          );
        }
        return errorRedirect("Missing state parameter");
      }
      if (!state || state.provider !== provider) {
        return errorRedirect("Invalid state parameter");
      }

      if (!state.workspaceId) {
        return errorRedirect("Missing workspace in state");
      }

      const stateWorkspace = await db.workspace.findUnique({
        where: { id: state.workspaceId },
        select: { organizationId: true },
      });
      if (!stateWorkspace) return errorRedirect("Workspace not found");
      const stateOrgId = stateWorkspace.organizationId;

      // Microsoft can send duplicate callbacks -- the first with a valid code
      // (which succeeds) and the second with error=server_error. If a
      // connection was created moments ago during this same OAuth flow,
      // treat the error callback as a no-op and redirect to success.
      if (c.req.query("error")) {
        const recentCutoff = new Date(Date.now() - 30_000);
        const existing = await listConnectionsByProvider(
          { workspaceId: state.workspaceId },
          provider,
        );
        const justCreated = existing.find(
          (conn) =>
            conn.status === "connected" && conn.connectedAt >= recentCutoff,
        );
        if (justCreated) {
          const successParams = new URLSearchParams({ status: "success" });
          if (state.agentName) {
            successParams.set("agent_name", state.agentName as string);
          }
          // Same attach-step params as the primary success path — this IS the
          // success redirect for the connection the first callback created.
          successParams.set("connected", justCreated.id);
          successParams.set("workspaceId", state.workspaceId);
          return c.redirect(
            `${appOrigin}/app-connect/${provider}?${successParams}`,
          );
        }
      }

      const resolved = await resolveAppCredentials(
        state.workspaceId,
        appDef,
        stateOrgId,
      );
      if (!resolved) {
        return errorRedirect(`${appDef.name} is not configured`);
      }

      // Exactly the redirect_uri the authorize leg sent (signed into the state).
      const redirectPath = signedRedirectPath(state, provider);
      const redirectUri = `${apiOrigin}${redirectPath}`;

      const url = new URL(c.req.url);
      const callbackParams = Object.fromEntries(url.searchParams.entries());

      const accessLevel = accessLevelFromState(
        appDef.connectionMethod,
        state.accessLevel,
      );
      const exchangeParams = {
        appCredentials: resolved.values,
        callbackParams,
        redirectUri,
        ...(accessLevel ? { accessLevel } : {}),
        state,
        stateCookie: getCookie(c, OAUTH_STATE_COOKIE),
      };

      // One more provider round trip before anything is stored: the next leg
      // returns to this same callback path, bound to this browser's cookie.
      const continuation =
        await appDef.connectionMethod.continueCallback?.(exchangeParams);
      if (continuation) {
        setCookie(
          c,
          OAUTH_STATE_COOKIE,
          continuation.state,
          oauthStateCookieOptions(redirectPath),
        );
        return c.redirect(continuation.continueAt);
      }

      const { credentials, scopes, metadata } =
        await appDef.connectionMethod.exchangeCode(exchangeParams);

      let reconnectId = state.connectionId as string | undefined;

      if (!reconnectId && provider !== "github-app") {
        const identity = extractLabel(metadata)?.toLowerCase().trim();
        if (identity) {
          const existing = await listConnectionsByProvider(
            { workspaceId: state.workspaceId },
            provider,
          );
          const duplicate = existing.find(
            (conn) => conn.label?.toLowerCase().trim() === identity,
          );
          if (duplicate) reconnectId = duplicate.id;
        }
      }

      // The freshly-CREATED connection id rides the success redirect so the
      // popup can offer the post-connect attach step. A consent that landed on
      // an existing connection doesn't: its grants stay as they are (a fresh
      // connect only adds the connecting agent, below).
      let createdId: string | null = null;
      // The connection this consent landed on, created or re-authenticated.
      let connectionId: string;
      // The agent the connect started from (signed at /authorize, fenced
      // there), and the actor: the callback is unauthenticated, so both come
      // from the signed state.
      const connectingAgentId =
        typeof state.agentId === "string" ? state.agentId : undefined;
      const actorId = typeof state.userId === "string" ? state.userId : null;

      if (provider === "github-app") {
        const result = await connectGitHubInstallation({
          scope: { workspaceId: state.workspaceId },
          organizationId: stateOrgId,
          credentials,
          options: { scopes, metadata, appConfigId: resolved.appConfigId },
          reconnectId,
          beforeCreate: () => getConnectionHooks().beforeCreate(stateOrgId),
        });
        if (result.status === "updated") {
          deleteCookie(c, OAUTH_STATE_COOKIE, { path: redirectPath });
          return c.redirect(
            `${appOrigin}/app-connect/${provider}?status=updated`,
          );
        }
        connectionId = result.connection.id;
        if (result.status === "created") createdId = connectionId;
        if (!state.connectionId) {
          await grantConnectingAgent(
            state.workspaceId,
            connectionId,
            connectingAgentId,
            actorId,
          );
        }
      } else if (reconnectId) {
        const updated = await reconnectConnection(
          { workspaceId: state.workspaceId },
          reconnectId,
          credentials,
          {
            scopes,
            metadata,
            appConfigId: resolved.appConfigId,
          },
        );
        connectionId = updated.id;
        // A fresh connect (no reconnect asked for) that landed on this
        // account by name: on for the connecting agent too. An explicit
        // Reconnect only refreshes credentials and grants nothing.
        if (!state.connectionId) {
          await grantConnectingAgent(
            state.workspaceId,
            updated.id,
            connectingAgentId,
            actorId,
          );
        }
      } else {
        await getConnectionHooks().beforeCreate(stateOrgId);
        const fresh = await createConnection(
          { workspaceId: state.workspaceId },
          provider,
          credentials,
          {
            scopes,
            metadata,
            appConfigId: resolved.appConfigId,
          },
        );
        createdId = fresh.id;
        connectionId = fresh.id;
        // A new workspace connection is on for no agent, except the one the
        // connect started from; the post-connect dialog is where the user
        // turns others on.
        await grantConnectingAgent(
          state.workspaceId,
          fresh.id,
          connectingAgentId,
          actorId,
        );
      }

      if (appDef.blocklist?.length) {
        await initBlocklistDefaults(
          { workspaceId: state.workspaceId },
          provider,
          appDef.blocklist,
        );
      }

      invalidateGatewayCacheForAccount(state.workspaceId);

      const successParams = new URLSearchParams({ status: "success" });
      if (state.agentName) {
        successParams.set("agent_name", state.agentName as string);
      }
      // `connected` (NOT `connectionId` — that param means "re-authenticate
      // this connection" on the popup page) + the workspace, so the popup can
      // offer grants for the brand-new connection.
      if (createdId) {
        successParams.set("connected", createdId);
        successParams.set("workspaceId", state.workspaceId);
      }
      // Permissions the user unticked on the consent screen: the popup warns
      // and offers to try again on this same connection.
      setPartialGrantParams(successParams, provider, scopes, {
        connectionId,
        scope: { workspaceId: state.workspaceId },
      });

      deleteCookie(c, OAUTH_STATE_COOKIE, { path: redirectPath });

      return c.redirect(
        `${appOrigin}/app-connect/${provider}?${successParams}`,
      );
    } catch (err) {
      logger.error({ err, provider }, "OAuth callback failed");
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred";
      return errorRedirect(message);
    }
  };

  // The state a callback carries: in the query, or in the `oauth_state` cookie
  // `/authorize` set on the callback's path.
  const readCallbackState = (c: Context<ApiEnv>) => {
    const stateParam = c.req.query("state") ?? getCookie(c, OAUTH_STATE_COOKIE);
    return {
      stateParam,
      state: stateParam ? verifyOAuthState(stateParam) : null,
    };
  };

  // A state this callback path must not complete. Nothing is verified for it,
  // so the destination comes from the request, never from the state.
  const invalidStateRedirect = (c: Context<ApiEnv>, landing: string) =>
    c.redirect(
      `${getAppOrigin(c.req.raw)}/app-connect/${landing}?status=error&message=${encodeURIComponent("Invalid state parameter")}`,
    );

  // ── GET /apps/oauth/:group/callback ── vendor-shared OAuth callback ─────
  // One redirect URI per vendor (Google, Atlassian, Microsoft) for clients
  // shared across that vendor's apps: an admin registers a single URL, and a
  // single-callback vendor app (Atlassian 3LO) serves every member app. The
  // app being connected rides the signed state; it must belong to the vendor
  // in the path AND the state must have been minted for this exact path, so a
  // per-app state cannot be replayed here (or vice versa).
  app.get("/oauth/:group/callback", async (c) => {
    const group = c.req.param("group")!;
    if (!isOAuthClientGroupId(group)) return c.notFound();
    const { stateParam, state } = readCallbackState(c);
    const provider = state?.provider;
    if (
      !provider ||
      groupOf(provider) !== group ||
      state.redirectPath !== vendorCallbackPath(group)
    ) {
      // Land on a real app's connect page, which renders the error: the
      // state's app when it is one, else the vendor's first app.
      return invalidStateRedirect(
        c,
        provider && getApp(provider) ? provider : groupMembers(group)[0]!,
      );
    }
    return handleOAuthCallback(c, provider, stateParam, state);
  });

  // ── GET /apps/:provider/callback ── OAuth callback ─────────────────────
  // Serves states minted for the per-app path (platform clients, legacy
  // per-app configs, and states minted before vendor callbacks existed). A
  // state minted for the vendor path is refused here, mirroring the vendor
  // route's check, so each state completes only where it was registered.
  app.get("/:provider/callback", (c) => {
    const provider = c.req.param("provider")!;
    const { stateParam, state } = readCallbackState(c);
    if (
      state &&
      signedRedirectPath(state, provider) !== appCallbackPath(provider)
    ) {
      return invalidStateRedirect(c, provider);
    }
    return handleOAuthCallback(c, provider, stateParam, state);
  });

  // ── POST /apps/:provider/connect ── direct connect ─────────────────────
  app.post(
    "/:provider/connect",
    auth({ requireWorkspace: false }),
    async (c) => {
      const auth = c.get("auth");
      const provider = c.req.param("provider")!;
      const appDef = getApp(provider);

      if (!appDef) {
        return c.json(
          { error: `Provider "${provider}" is not available` },
          400,
        );
      }

      const body = (await c.req
        .json()
        .catch(() => null)) as ConnectRequestBody | null;
      // An org connect (`X-Organization-Id`) naming an agent is refused here,
      // before the org interceptor takes the request: agents live in
      // workspaces. The workspace arm resolves it below, once the workspace
      // is known.
      if (c.req.header("x-organization-id")) {
        await resolveConnectingAgent(null, body?.agentId);
      }

      // The org this connect actually lands in. The legacy `X-Organization-Id`
      // interceptor (`tryHandleOrgConnect`, below) re-scopes the request to the
      // named org, which need NOT be the workspace-derived
      // `auth.organizationId` — a caller may hold both. Server-owned fields
      // must resolve against the org the connection really lands in, and that
      // org has to be fenced HERE, because the interceptor's own membership
      // gate runs later, after the resolve. (The interceptor still applies the
      // role check; this is only the "may you touch this org at all" arm.)
      const headerOrgId = c.req.header("x-organization-id");
      if (
        headerOrgId &&
        headerOrgId !== auth.organizationId &&
        !(await hasActiveMembership(auth.userId, headerOrgId))
      ) {
        return c.json({ error: "Not a member of this organization" }, 403);
      }

      const resolved = await resolveConnectCredentials(
        provider,
        appDef,
        body,
        headerOrgId ?? auth.organizationId,
      );
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
      // creating a workspace-scoped connection.
      if (c.req.header("x-organization-id")) {
        return c.json(
          {
            error:
              "Organization-scoped connections are not supported on this server",
          },
          400,
        );
      }

      const workspaceId = requireWorkspaceId(auth);
      // The agent this connect started from: a created or re-added
      // connection is switched on for it. Fenced before anything is stored,
      // so a foreign or unknown id is a 404 and leaves no connection behind.
      const connectingAgentId = await resolveConnectingAgent(
        workspaceId,
        body?.agentId,
      );

      // Workspace-scoped connect starts with no config link — body-provided
      // credentials have no minting config. The credentials-import branch below
      // re-links to the workspace config it saves; the explicit `undefined` also
      // clears any stale link when reconnecting an existing connection.
      const workspaceConnectionOpts = {
        ...connectionOpts,
        appConfigId: undefined,
      };

      let connection: { id: string };
      // The freshly-CREATED connection (never a reconnect/duplicate): the popup's
      // post-connect attach step only offers grants for brand-new connections.
      // An existing one keeps its grants (a re-add only adds the connecting
      // agent).
      let created: { id: string; label: string | null } | null = null;

      if (body?.connectionId) {
        connection = await reconnectConnection(
          { workspaceId },
          body.connectionId,
          credentials,
          workspaceConnectionOpts,
        );
      } else {
        const existing = await listConnectionsByProvider(
          { workspaceId },
          provider,
        );
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
            { workspaceId },
            duplicate.id,
            credentials,
            workspaceConnectionOpts,
          );
          // Connecting an account that is already here: every grant stays as
          // it is, and it is on for the connecting agent too.
          await grantConnectingAgent(
            workspaceId,
            duplicate.id,
            connectingAgentId,
            auth.userId,
          );
        } else {
          await getConnectionHooks().beforeCreate(auth.organizationId);
          const fresh = await createConnection(
            { workspaceId },
            provider,
            credentials,
            workspaceConnectionOpts,
          );
          connection = fresh;
          created = { id: fresh.id, label: fresh.label };
          // On for no agent, except the one the connect started from.
          await grantConnectingAgent(
            workspaceId,
            fresh.id,
            connectingAgentId,
            auth.userId,
          );
        }
      }

      if (appDef.blocklist?.length) {
        await initBlocklistDefaults(
          { workspaceId },
          provider,
          appDef.blocklist,
        );
      }

      if (
        activeMethod.type === "credentials_import" &&
        !fields.privateKey &&
        fields.clientId &&
        fields.clientSecret
      ) {
        const savedConfig = await saveAppConfigWithoutDisconnect(
          { workspaceId },
          provider,
          fields.clientId,
          fields.clientSecret,
        );
        // This connection was imported alongside its own workspace config — record
        // that provenance so config removal/refresh can find it.
        await linkConnectionToAppConfig(
          { workspaceId },
          connection.id,
          savedConfig.id,
        );
      }

      invalidateGatewayCache(c.req.raw);

      // `connection` is present only for a brand-new connection: the popup's
      // attach step keys on it (an existing one keeps its grants, plus the
      // connecting agent on a re-add).
      return c.json(
        created ? { success: true, connection: created } : { success: true },
      );
    },
  );

  // ── GET /apps/:provider/permission-definition ── tool catalog ──────────
  // The static permission catalog (groups + toolIds) that
  // GET/PUT /rules/permissions/:provider operate on. Global data — no workspace
  // context required, so org-key callers work without X-Workspace-Id.
  app.get(
    "/:provider/permission-definition",
    auth({ requireWorkspace: false }),
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
      { workspaceId: requireWorkspaceId(auth) },
      provider,
    );
    if (config?.enabled) return c.json(config);

    // Org tier (orgAppConfig seam): no enabled workspace row — report the org-level
    // config as configured, marked `source: "organization"` so the workspace
    // config form knows there is no workspace row to edit. Org settings are
    // deliberately not exposed on the workspace surface.
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
  app.post("/:provider/config", configAdmin, async (c) => {
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

    const workspaceId = requireWorkspaceId(auth);
    await withAudit(
      () =>
        upsertAppConfig(
          { workspaceId },
          provider,
          values,
          appDef.configurable!.fields,
        ),
      () => ({
        workspaceId,
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
  app.delete("/:provider/config", configAdmin, async (c) => {
    const auth = c.get("auth");
    const provider = c.req.param("provider")!;
    const workspaceId = requireWorkspaceId(auth);
    await withAudit(
      () => deleteAppConfig({ workspaceId }, provider),
      () => ({
        workspaceId,
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
  app.patch("/:provider/config/toggle", configAdmin, async (c) => {
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
    const workspaceId = requireWorkspaceId(auth);
    await withAudit(
      () =>
        toggleAppConfigEnabled({ workspaceId }, provider, parsed.data.enabled),
      () => ({
        workspaceId,
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
    const workspaceId = requireWorkspaceId(auth);
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);
    if (!appDef) return c.json({ error: "Unknown provider" }, 404);

    const states = await getBlocklistState(
      { workspaceId, organizationId: auth.organizationId },
      provider,
      appDef.blocklist ?? [],
    );
    return c.json(states);
  });

  // ── POST /apps/:provider/blocklist ── activate one of the app's hosts ──
  app.post("/:provider/blocklist", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const provider = c.req.param("provider")!;
    const appDef = getApp(provider);
    if (!appDef) return c.json({ error: "Unknown provider" }, 404);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid request body" }, 400);

    // Blocking an arbitrary host is a policy rule (POST /v1/policy/rules) now;
    // this surface only toggles the hosts the app itself declares.
    if (!body.hostId) {
      return c.json({ error: "Provide { hostId }" }, 400);
    }
    const result = await activateBlocklistHost(
      { workspaceId },
      provider,
      body.hostId,
      appDef.blocklist ?? [],
    );

    invalidateGatewayCache(c.req.raw);
    return c.json(result, 201);
  });

  // ── PATCH /apps/:provider/blocklist/:ruleId ── toggle enabled ─────────
  app.patch("/:provider/blocklist/:ruleId", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const ruleId = c.req.param("ruleId")!;

    const body = await c.req.json().catch(() => null);
    if (body?.enabled === undefined)
      return c.json({ error: "enabled is required" }, 400);

    await toggleBlocklistRule({ workspaceId }, ruleId, body.enabled);
    invalidateGatewayCache(c.req.raw);
    return c.json({ success: true });
  });

  // ── DELETE /apps/:provider/blocklist/:ruleId ── remove blocklist rule ──
  app.delete("/:provider/blocklist/:ruleId", authMiddleware, async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const ruleId = c.req.param("ruleId")!;

    await removeBlocklistRule({ workspaceId }, ruleId);
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  return app;
};
