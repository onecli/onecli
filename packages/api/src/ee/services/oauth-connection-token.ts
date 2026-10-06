import { db } from "@onecli/db";
import { getApp } from "../../apps/registry";
import {
  resolveAppCredentials,
  type ResolvedAppCredentials,
} from "../../apps/resolve-credentials";
import { resolveOrgAppCredentials } from "../../apps/resolve-org-credentials";
import { getAppConfigCredentialsById } from "../../services/app-config-service";
import { reconnectConnection } from "../../services/connection-service";
import { ServiceError } from "../../services/errors";
import { getCrypto } from "../../providers";
import { logger } from "../../lib/logger";

/**
 * Live access to a connected OAuth app from the dashboard (folder pickers).
 * The dashboard calls the provider directly — not through the gateway — so it
 * must decrypt the connection and refresh its token itself.
 */

export interface OAuthCredentials {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  [key: string]: unknown;
}

/** Per provider call from a picker: a slow upstream fails the request, never
 * hangs it. */
export const PROVIDER_TIMEOUT_MS = 10_000;

export interface OAuthConnection {
  id: string;
  credentials: string | null;
  scope: string;
  workspaceId: string | null;
  organizationId: string | null;
  appConfigId: string | null;
}

/**
 * Who is browsing: the org they act in and, when the request names one, the
 * workspace they act from (`X-Workspace-Id`, already access-checked by the auth
 * middleware).
 */
export interface ConnectionAccessScope {
  organizationId: string;
  workspaceId?: string;
}

/**
 * Loads a CONNECTED connection of `provider` the caller may see, and decrypts
 * it. Same ownership law as the connections routes: an org-scoped row in the
 * caller's org, or a workspace-scoped row in the caller's OWN workspace. A
 * workspace row is never reachable by org membership alone — that would let a
 * member read the folder tree of another workspace's (another person's)
 * account they were never given access to.
 *
 * @throws ServiceError NOT_FOUND when no such connection is visible (absent,
 *   foreign org, or another workspace's) — existence is never confirmed.
 */
export const loadOAuthConnection = async (
  scope: ConnectionAccessScope,
  connectionId: string,
  provider: string,
): Promise<{ conn: OAuthConnection; creds: OAuthCredentials }> => {
  const { organizationId, workspaceId } = scope;
  const conn = await db.appConnection.findFirst({
    where: {
      id: connectionId,
      provider,
      status: "connected",
      OR: [
        { organizationId, scope: "organization" },
        ...(workspaceId
          ? [{ workspaceId, workspace: { organizationId } }]
          : []),
      ],
    },
    select: {
      id: true,
      credentials: true,
      scope: true,
      workspaceId: true,
      organizationId: true,
      appConfigId: true,
    },
  });
  if (!conn?.credentials) {
    throw new ServiceError("NOT_FOUND", "Connection not found");
  }
  try {
    const creds = JSON.parse(
      await getCrypto().decrypt(conn.credentials),
    ) as OAuthCredentials;
    return { conn, creds };
  } catch {
    throw new Error("Failed to read connection credentials");
  }
};

/**
 * Returns a valid access token for the connection, refreshing (and persisting)
 * it first when expired.
 */
export const validAccessToken = async (
  conn: OAuthConnection,
  creds: OAuthCredentials,
  provider: string,
  tokenUrl: string,
): Promise<string | null> => {
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof creds.expires_at === "number" &&
    creds.expires_at > now + 60 &&
    creds.access_token
  ) {
    return creds.access_token;
  }
  if (!creds.refresh_token) return creds.access_token ?? null;

  const app = getApp(provider);
  if (!app) return creds.access_token ?? null;

  // Refresh with the config that minted this connection (its refresh token is
  // bound to that OAuth client). Fall back — for connections with no link — to
  // the connection's own credential chain: workspace connections resolve
  // workspace → org → env, org connections resolve the org tier directly.
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  if (conn.appConfigId) {
    const linked = await getAppConfigCredentialsById(conn.appConfigId);
    clientId = linked?.clientId;
    clientSecret = linked?.clientSecret;
  }
  if (!clientId || !clientSecret) {
    let resolved: ResolvedAppCredentials | null = null;
    if (conn.workspaceId) {
      // Workspace connection: workspace → org → env. Derive the org so the org tier
      // is reachable.
      const organizationId = (
        await db.workspace.findUnique({
          where: { id: conn.workspaceId },
          select: { organizationId: true },
        })
      )?.organizationId;
      resolved = await resolveAppCredentials(
        conn.workspaceId,
        app,
        organizationId ?? undefined,
      );
    } else if (conn.organizationId) {
      // Org connection: no workspace, so resolve the org tier directly —
      // resolveAppCredentials requires a workspace id and would throw on "".
      resolved = await resolveOrgAppCredentials(conn.organizationId, app);
    }
    clientId = resolved?.values.clientId;
    clientSecret = resolved?.values.clientSecret;
  }
  if (!clientId || !clientSecret) return creds.access_token ?? null;

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) return creds.access_token ?? null;

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) return creds.access_token ?? null;

  const updated: OAuthCredentials = {
    ...creds,
    access_token: data.access_token,
    expires_at: data.expires_in ? now + data.expires_in : undefined,
  };
  const scope =
    conn.scope === "organization"
      ? { organizationId: conn.organizationId ?? undefined }
      : { workspaceId: conn.workspaceId ?? undefined };
  await reconnectConnection(scope, conn.id, updated).catch((err) => {
    // Non-fatal: we still return the freshly refreshed token for this request;
    // we just couldn't persist it, so the next call will refresh again.
    logger.warn(
      { err, connectionId: conn.id, provider },
      "failed to persist refreshed OAuth token",
    );
  });
  return data.access_token;
};
