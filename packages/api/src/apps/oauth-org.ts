import { generateCookie, setCookie } from "hono/cookie";
import { parse as parseCookies } from "hono/utils/cookie";
import type { Context } from "hono";
import { resolveOrgAppCredentials } from "./resolve-org-credentials";
import { saveAppConfigWithoutDisconnect } from "../services/app-config-service";
import { getApp } from "./registry";
import {
  authorizeScopesFor,
  redirectPathFor,
  signedRedirectPath,
} from "./oauth/groups";
import { accessLevelFromState, resolveAccessLevel } from "./access-level";
import { extractLabel } from "../lib/connection-display";
import { setPartialGrantParams } from "./missing-permissions";
import {
  createConnection,
  reconnectConnection,
  linkConnectionToAppConfig,
  listConnectionsByProvider,
} from "../services/connection-service";
import { connectGitHubInstallation } from "../services/github-installation-connect-service";
import {
  recordAuditEvent,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";
import { getApiCallbackOrigin, getAppOrigin } from "../lib/request-origin";
import { invalidateGatewayCacheForOrg } from "../lib/gateway-invalidate";
import { initBlocklistDefaults } from "../services/app-blocklist-service";
import {
  signOAuthState,
  generateNonce,
  verifyOAuthState,
  OAUTH_STATE_COOKIE,
  oauthStateCookieOptions,
} from "../lib/oauth-state";
import { logger } from "../lib/logger";
import {
  SKILLS_ONLY_UNAVAILABLE,
  SKILLS_PURPOSE,
  isSkillsOnlyState,
  signLibraryGrant,
} from "../services/skill-library-grant";
import { githubInstallsAreProven } from "./github-app";
import { db } from "@onecli/db";
import { ROLE_HIERARCHY } from "../providers";
import type { AuthContext } from "../providers";
import { CAPS } from "../lib/env";

/**
 * The org-door authorization shared by BOTH entry points: the canonical
 * /org/apps routes gate via `auth({ role: "admin" })`, but the legacy
 * interceptors ride the plain-auth workspace endpoints (`?_org=`,
 * `X-Organization-Id`), so the same threshold must hold here or the admin
 * gate is one header away from moot. Membership (non-suspended) is the fence
 * on every deployment; the admin threshold applies only where roles are
 * enforced (`CAPS.rbac`) — flat teams pass every active member, matching
 * `requireRole`.
 */
const requireOrgDoor = async (
  userId: string,
  organizationId: string,
): Promise<Response | null> => {
  const membership = await db.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId, userId },
    },
    select: { status: true, role: true },
  });
  if (!membership || membership.status === "suspended") {
    return Response.json(
      { error: "Not a member of this organization" },
      { status: 403 },
    );
  }
  if (CAPS.rbac) {
    const role = membership.role as keyof typeof ROLE_HIERARCHY;
    if (
      !(role in ROLE_HIERARCHY) ||
      ROLE_HIERARCHY[role] < ROLE_HIERARCHY.admin
    ) {
      return Response.json(
        { error: "Insufficient permissions" },
        { status: 403 },
      );
    }
  }
  return null;
};

/**
 * Org-scoped OAuth start. Core shared by the canonical
 * `GET /org/apps/:provider/authorize` route and the legacy `?_org=`
 * interceptor on the workspace authorize endpoint (`tryHandleOrgAuthorize`) —
 * responses are byte-identical between the two entry points.
 *
 * The redirect URI is the per-app `/v1/apps/:provider/callback`, or, when the
 * org's credentials are a vendor-shared client (e.g. its Google client), the
 * vendor's single `/v1/apps/oauth/:group/callback`. The org scope and the
 * exact redirect path ride the signed state.
 */
export const orgAuthorize = async (
  auth: AuthContext,
  c: Context,
  provider: string,
  orgId: string,
): Promise<Response> => {
  const refused = await requireOrgDoor(auth.userId, orgId);
  if (refused) return refused;

  const app = getApp(provider);
  if (!app || app.connectionMethod.type !== "oauth") {
    return Response.json(
      { error: `Provider "${provider}" is not available` },
      { status: 400 },
    );
  }

  const connectionId = c.req.query("connectionId");
  // "Install GitHub for skills only": the callback stores no connection
  // (see `skill-library-grant`). GitHub App only.
  const skillsOnly =
    provider === "github-app" && c.req.query("purpose") === SKILLS_PURPOSE;

  const accessLevel = resolveAccessLevel(
    app.connectionMethod,
    c.req.query("access_level"),
  );
  if (!accessLevel.ok) {
    return Response.json({ error: accessLevel.error }, { status: 400 });
  }

  const resolved = await resolveOrgAppCredentials(orgId, app);
  if (!resolved) {
    return Response.json(
      { error: `${app.name} is not configured. Missing required credentials.` },
      { status: 400 },
    );
  }

  const { values: creds } = resolved;
  // A skills-only grant hands out read access by installation id, so it is
  // only offered where GitHub proves the user can access that installation.
  if (skillsOnly && !githubInstallsAreProven(creds.appId)) {
    return Response.json({ error: SKILLS_ONLY_UNAVAILABLE }, { status: 400 });
  }
  const redirectPath = redirectPathFor(provider, resolved.configKey);

  // Same reasoning as the workspace-scoped authorize in `routes/apps.ts`: decide
  // the post-consent destination here, where the caller is authenticated, and
  // sign it — the shared callback that reads it back is not.
  const state = signOAuthState({
    ...(auth.workspaceId ? { workspaceId: auth.workspaceId } : {}),
    organizationId: orgId,
    provider,
    scope: "organization",
    nonce: generateNonce(),
    origin: getAppOrigin(c.req.raw),
    redirectPath,
    ...(connectionId ? { connectionId } : {}),
    ...(accessLevel.value ? { accessLevel: accessLevel.value } : {}),
    // Who started it: a skills-only install hands its grant to this user.
    ...(auth.userId ? { userId: auth.userId } : {}),
    ...(skillsOnly ? { purpose: SKILLS_PURPOSE } : {}),
  });

  // The API origin the provider must send the browser back to — same rule as
  // the workspace-scoped legs in routes/apps.ts: an explicitly configured
  // API_URL wins, else the origin this request arrived on. Never the DEFAULTED
  // selfUrl constant, which strands a remote self-host on localhost.
  const baseUrl = getApiCallbackOrigin(c.req.raw);
  const redirectUri = `${baseUrl}${redirectPath}`;
  const scopes = authorizeScopesFor(app, resolved.configKey);

  const authUrl = await app.connectionMethod.buildAuthUrl({
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
};

export const tryHandleOrgAuthorize = async (
  auth: AuthContext,
  c: Context,
  provider: string,
): Promise<Response | null> => {
  const orgId = c.req.query("_org");
  if (!orgId) return null;

  return orgAuthorize(auth, c, provider, orgId);
};

/**
 * The org state a callback carries. The query's `state` is the normal case.
 * Only a callback its provider declares stateless (a GitHub App setup
 * redirect after "Configure") may fall back to this browser's `oauth_state`
 * cookie: anywhere else a missing state would let a code from someone
 * else's sign-in complete against this browser's pending org flow.
 */
const readOrgCallbackState = (
  url: URL,
  cookieHeader: string,
  provider: string,
): string | undefined => {
  const fromQuery = url.searchParams.get("state");
  if (fromQuery) return fromQuery;
  const app = getApp(provider);
  const params = Object.fromEntries(url.searchParams.entries());
  if (
    app?.connectionMethod.type !== "oauth" ||
    !app.connectionMethod.acceptsCookieOnlyState?.(params)
  ) {
    return undefined;
  }
  return parseCookies(cookieHeader, OAUTH_STATE_COOKIE)[OAUTH_STATE_COOKIE];
};

export const tryHandleOrgCallback = async (
  request: Request,
  provider: string,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie") ?? "";
  const stateParam = readOrgCallbackState(url, cookieHeader, provider);
  if (!stateParam) return null;

  const state = verifyOAuthState(stateParam);
  if (!state || state.scope !== "organization") return null;

  const organizationId = state.organizationId as string;
  if (!organizationId) return null;

  // Same rule as the workspace-scoped callback in `routes/apps.ts` — the browser
  // is headed for a dashboard page, which cloud serves on a different host than
  // the api-server answering here.
  //
  // The state verified above, so `state.origin` is the destination committed to
  // at `/authorize`; it beats this unauthenticated request's headers and loses
  // only to a configured APP_URL. No `let` dance here — unlike the workspace
  // callback, nothing redirects before the state is checked.
  const appOrigin = getAppOrigin(request, state.origin);
  const redirectPath = signedRedirectPath(state, provider);

  // Every outcome but a continuation ends this browser's flow: the state
  // cookie goes with it (as on the workspace callback), so a later stateless
  // GitHub redirect can't pick up a finished flow's state.
  const finish = (location: string) =>
    new Response(null, {
      status: 302,
      headers: {
        location,
        "set-cookie": generateCookie(OAUTH_STATE_COOKIE, "", {
          ...oauthStateCookieOptions(redirectPath),
          maxAge: 0,
        }),
      },
    });
  const errorRedirect = (msg: string) =>
    finish(
      `${appOrigin}/app-connect/${provider}?status=error&message=${encodeURIComponent(msg)}`,
    );

  try {
    const app = getApp(provider);
    if (!app || app.connectionMethod.type !== "oauth") {
      return errorRedirect("Invalid provider");
    }

    const resolved = await resolveOrgAppCredentials(organizationId, app);
    if (!resolved) {
      return errorRedirect(`${app.name} is not configured`);
    }

    // Must resolve identically to the /authorize leg above or the exchange
    // fails — both call getApiCallbackOrigin, and the provider sends the
    // browser back to the same origin the authorize leg derived.
    const baseUrl = getApiCallbackOrigin(request);
    const redirectUri = `${baseUrl}${redirectPath}`;
    const callbackParams = Object.fromEntries(url.searchParams.entries());

    const accessLevel = accessLevelFromState(
      app.connectionMethod,
      state.accessLevel,
    );
    const exchangeParams = {
      appCredentials: resolved.values,
      callbackParams,
      redirectUri,
      ...(accessLevel ? { accessLevel } : {}),
      state,
      stateCookie: parseCookies(cookieHeader, OAUTH_STATE_COOKIE)[
        OAUTH_STATE_COOKIE
      ],
    };

    // One more provider round trip before anything is stored: the next leg
    // returns to this same callback path, bound to this browser's cookie.
    const continuation =
      await app.connectionMethod.continueCallback?.(exchangeParams);
    if (continuation) {
      return new Response(null, {
        status: 302,
        headers: {
          location: continuation.continueAt,
          "set-cookie": generateCookie(
            OAUTH_STATE_COOKIE,
            continuation.state,
            oauthStateCookieOptions(redirectPath),
          ),
        },
      });
    }

    const { credentials, scopes, metadata } =
      await app.connectionMethod.exchangeCode(exchangeParams);

    // Skills only: the ownership proof above passed; store NOTHING, hand the
    // popup a signed grant the library's connect accepts (same org + user).
    // Belt: never for an installation id nothing proved (the authorize leg
    // refuses to start one, but the config may have changed since).
    if (isSkillsOnlyState(state)) {
      const userId = typeof state.userId === "string" ? state.userId : null;
      const installationId = credentials.installation_id;
      if (!githubInstallsAreProven(resolved.values.appId)) {
        return errorRedirect(SKILLS_ONLY_UNAVAILABLE);
      }
      if (!userId || typeof installationId !== "string") {
        return errorRedirect("Invalid state parameter");
      }
      const grant = signLibraryGrant({
        organizationId,
        userId,
        grant: {
          installationId,
          account:
            typeof metadata?.username === "string" ? metadata.username : null,
          accountType:
            typeof metadata?.accountType === "string"
              ? metadata.accountType
              : null,
        },
      });
      // In the fragment: never sent to a server, so never in access logs.
      return finish(
        `${appOrigin}/app-connect/${provider}?status=library#g=${encodeURIComponent(grant)}`,
      );
    }

    const initiatingUserId =
      typeof state.userId === "string" ? state.userId : null;
    if (provider === "github-app") {
      if (
        !initiatingUserId ||
        (await requireOrgDoor(initiatingUserId, organizationId))
      ) {
        return errorRedirect("Organization access denied");
      }
    }
    const githubActor =
      provider === "github-app" && initiatingUserId
        ? await db.user.findUnique({
            where: { id: initiatingUserId },
            select: { email: true },
          })
        : null;

    let reconnectId = state.connectionId as string | undefined;

    if (!reconnectId && provider !== "github-app") {
      const identity = extractLabel(metadata)?.toLowerCase().trim();
      if (identity) {
        const existing = await listConnectionsByProvider(
          { organizationId },
          provider,
        );
        const duplicate = existing.find(
          (c) => c.label?.toLowerCase().trim() === identity,
        );
        if (duplicate) reconnectId = duplicate.id;
      }
    }
    // GitHub installation identity, dedupe and promotion are resolved under
    // one transaction. Labels never identify a GitHub installation.
    const githubResult =
      provider === "github-app"
        ? await connectGitHubInstallation({
            scope: { organizationId },
            organizationId,
            credentials,
            options: { scopes, metadata, appConfigId: resolved.appConfigId },
            reconnectId,
            allowPromotion: true,
          })
        : null;
    if (githubResult?.status === "updated") {
      return finish(`${appOrigin}/app-connect/${provider}?status=updated`);
    }

    // The connection this consent landed on, created or re-authenticated.
    const connection = githubResult
      ? githubResult.connection
      : reconnectId
        ? await reconnectConnection(
            { organizationId },
            reconnectId,
            credentials,
            { scopes, metadata, appConfigId: resolved.appConfigId },
          )
        : await createConnection({ organizationId }, provider, credentials, {
            scopes,
            metadata,
            appConfigId: resolved.appConfigId,
          });

    if (app.blocklist?.length) {
      await initBlocklistDefaults({ organizationId }, provider, app.blocklist);
    }

    // An org connection serves every workspace in the org — flush them all, not
    // just the workspace the dance started from.
    invalidateGatewayCacheForOrg(organizationId);

    if (githubResult?.promoted && initiatingUserId) {
      await recordAuditEvent({
        organizationId,
        userId: initiatingUserId,
        userEmail: githubActor?.email ?? "",
        action: AUDIT_ACTIONS.UPDATE,
        service: AUDIT_SERVICES.APP_CONNECTION,
        source: AUDIT_SOURCE.API,
        metadata: {
          connectionId: connection.id,
          provider,
          change: "promoted_to_organization",
        },
      });
    }

    const successParams = new URLSearchParams({ status: "success" });
    // Same partial-grant warning as the workspace callback: the popup offers
    // to re-authenticate this org connection.
    setPartialGrantParams(successParams, provider, scopes, {
      connectionId: connection.id,
      scope: { orgId: organizationId },
    });
    return finish(`${appOrigin}/app-connect/${provider}?${successParams}`);
  } catch (err) {
    logger.error({ err, provider }, "Org OAuth callback failed");
    const message =
      err instanceof Error ? err.message : "An unexpected error occurred";
    return errorRedirect(message);
  }
};

/**
 * Org-scoped direct connect (API key / imported credentials). Core shared by
 * the canonical `POST /org/apps/:provider/connect` route and the legacy
 * `X-Organization-Id` interceptor on the workspace connect endpoint
 * (`tryHandleOrgConnect`) — responses are byte-identical between the two.
 */
export const orgConnect = async (
  auth: AuthContext,
  provider: string,
  organizationId: string,
  credentials: Record<string, unknown>,
  options?: {
    scopes?: string[];
    metadata?: Record<string, unknown>;
    label?: string;
  },
  connectionId?: string,
  fields?: Record<string, string>,
): Promise<Response> => {
  const refused = await requireOrgDoor(auth.userId, organizationId);
  if (refused) return refused;

  const appDef = getApp(provider);

  // Direct-connect starts with no config link — body-provided credentials have
  // no minting config. The credentials-import branch below re-links to the org
  // config it saves; the explicit `undefined` also clears a stale link when
  // reconnecting (mirrors the workspace path in routes/apps.ts).
  const connectOpts = { ...options, appConfigId: undefined };
  let connection: { id: string };

  if (connectionId) {
    connection = await reconnectConnection(
      { organizationId },
      connectionId,
      credentials,
      connectOpts,
    );
  } else {
    const existing = await listConnectionsByProvider(
      { organizationId },
      provider,
    );
    const effectiveLabel =
      options?.label || extractLabel(options?.metadata) || null;
    const duplicate = effectiveLabel
      ? existing.find(
          (c) =>
            c.label?.toLowerCase().trim() ===
            effectiveLabel.toLowerCase().trim(),
        )
      : existing[0];

    if (duplicate) {
      connection = await reconnectConnection(
        { organizationId },
        duplicate.id,
        credentials,
        connectOpts,
      );
    } else {
      connection = await createConnection(
        { organizationId },
        provider,
        credentials,
        connectOpts,
      );
    }
  }

  if (appDef?.blocklist?.length) {
    await initBlocklistDefaults({ organizationId }, provider, appDef.blocklist);
  }

  if (fields && !fields.privateKey && fields.clientId && fields.clientSecret) {
    const savedConfig = await saveAppConfigWithoutDisconnect(
      { organizationId },
      provider,
      fields.clientId,
      fields.clientSecret,
    );
    // Imported alongside its own org config — record that provenance so config
    // removal/refresh can find it (matches the workspace credentials-import path).
    await linkConnectionToAppConfig(
      { organizationId },
      connection.id,
      savedConfig.id,
    );
  }

  // An org connection serves every workspace in the org — flush them all, not
  // just the workspace the request was scoped to.
  invalidateGatewayCacheForOrg(organizationId);

  return Response.json({ success: true });
};

export const tryHandleOrgConnect = async (
  auth: AuthContext,
  request: Request,
  provider: string,
  credentials: Record<string, unknown>,
  options?: {
    scopes?: string[];
    metadata?: Record<string, unknown>;
    label?: string;
  },
  connectionId?: string,
  fields?: Record<string, string>,
): Promise<Response | null> => {
  const organizationId = request.headers.get("x-organization-id");
  if (!organizationId) return null;

  return orgConnect(
    auth,
    provider,
    organizationId,
    credentials,
    options,
    connectionId,
    fields,
  );
};
