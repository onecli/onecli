import { setCookie } from "hono/cookie";
import type { Context } from "hono";
import { resolveOrgAppCredentials } from "./resolve-org-credentials";
import { saveAppConfigWithoutDisconnect } from "../services/app-config-service";
import { getApp } from "./registry";
import {
  extractLabel,
  createConnection,
  reconnectConnection,
  linkConnectionToAppConfig,
  listConnectionsByProvider,
} from "../services/connection-service";
import { NODE_ENV } from "../lib/env";
import { getApiCallbackOrigin, getAppOrigin } from "../lib/request-origin";
import { invalidateGatewayCacheForOrg } from "../lib/gateway-invalidate";
import { initBlocklistDefaults } from "../services/app-blocklist-service";
import {
  signOAuthState,
  generateNonce,
  verifyOAuthState,
} from "../lib/oauth-state";
import { logger } from "../lib/logger";
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
 * The redirect URI stays the shared `/v1/apps/:provider/callback` (the single
 * registered callback per provider); the org scope rides the signed state.
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
    ...(connectionId ? { connectionId } : {}),
  });

  const resolved = await resolveOrgAppCredentials(orgId, app);
  if (!resolved) {
    return Response.json(
      { error: `${app.name} is not configured. Missing required credentials.` },
      { status: 400 },
    );
  }

  const { values: creds } = resolved;

  // The API origin the provider must send the browser back to — same rule as
  // the workspace-scoped legs in routes/apps.ts: an explicitly configured
  // API_URL wins, else the origin this request arrived on. Never the DEFAULTED
  // selfUrl constant, which strands a remote self-host on localhost.
  const baseUrl = getApiCallbackOrigin(c.req.raw);
  const redirectUri = `${baseUrl}/v1/apps/${provider}/callback`;
  const scopes = app.connectionMethod.defaultScopes ?? [];

  const authUrl = await app.connectionMethod.buildAuthUrl({
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

export const tryHandleOrgCallback = async (
  request: Request,
  provider: string,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");
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

  const errorRedirect = (msg: string) =>
    Response.redirect(
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
    const redirectUri = `${baseUrl}/v1/apps/${provider}/callback`;
    const callbackParams = Object.fromEntries(url.searchParams.entries());

    const result = await app.connectionMethod.exchangeCode({
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
          { organizationId },
          provider,
        );
        const duplicate = existing.find(
          (c) => c.label?.toLowerCase().trim() === identity,
        );
        if (duplicate) reconnectId = duplicate.id;
      }
    }

    if (reconnectId) {
      await reconnectConnection({ organizationId }, reconnectId, credentials, {
        scopes,
        metadata,
        appConfigId: resolved.appConfigId,
      });
    } else {
      await createConnection({ organizationId }, provider, credentials, {
        scopes,
        metadata,
        appConfigId: resolved.appConfigId,
      });
    }

    if (app.blocklist?.length) {
      await initBlocklistDefaults({ organizationId }, provider, app.blocklist);
    }

    // An org connection serves every workspace in the org — flush them all, not
    // just the workspace the dance started from.
    invalidateGatewayCacheForOrg(organizationId);

    return Response.redirect(
      `${appOrigin}/app-connect/${provider}?status=success`,
    );
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
