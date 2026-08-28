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

const DROPBOX_API = "https://api.dropboxapi.com";

export interface DropboxFolder {
  id: string;
  name: string;
  pathLower: string;
  pathDisplay: string;
}

interface DropboxCredentials {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  [key: string]: unknown;
}

interface DropboxEntry {
  ".tag": string;
  id: string;
  name: string;
  path_lower?: string;
  path_display?: string;
}

interface ListFolderResult {
  entries?: DropboxEntry[];
  cursor?: string;
  has_more?: boolean;
}

interface DropboxConnection {
  id: string;
  credentials: string | null;
  scope: string;
  workspaceId: string | null;
  organizationId: string | null;
  appConfigId: string | null;
}

/**
 * Returns a valid access token for the connection, refreshing (and persisting)
 * it first when expired. The dashboard calls Dropbox directly (not through the
 * gateway), so it must handle token refresh itself.
 */
const validAccessToken = async (
  conn: DropboxConnection,
  creds: DropboxCredentials,
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

  const app = getApp("dropbox");
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

  const res = await fetch(`${DROPBOX_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) return creds.access_token ?? null;

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) return creds.access_token ?? null;

  const updated: DropboxCredentials = {
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
      { err, connectionId: conn.id },
      "failed to persist refreshed Dropbox token",
    );
  });
  return data.access_token;
};

/**
 * Lists the subfolders of `path` for a Dropbox connection owned by the given
 * organization (path "" or "/" = account root). Follows Dropbox pagination so
 * folders with many children aren't silently truncated.
 *
 * @throws ServiceError NOT_FOUND if the connection isn't found in the org,
 *   BAD_REQUEST if no usable access token can be obtained.
 */
export const listDropboxFolders = async (
  organizationId: string,
  connectionId: string,
  rawPath: string,
): Promise<DropboxFolder[]> => {
  const conn = await db.appConnection.findFirst({
    where: {
      id: connectionId,
      provider: "dropbox",
      status: "connected",
      OR: [{ organizationId }, { workspace: { organizationId } }],
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

  let creds: DropboxCredentials;
  try {
    creds = JSON.parse(await getCrypto().decrypt(conn.credentials));
  } catch {
    throw new Error("Failed to read Dropbox connection credentials");
  }

  const token = await validAccessToken(conn, creds);
  if (!token) {
    throw new ServiceError("BAD_REQUEST", "No valid Dropbox access token");
  }

  // Dropbox uses "" for the account root, "/Folder" for a subfolder.
  const path = rawPath === "/" ? "" : rawPath;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const folders: DropboxFolder[] = [];
  let cursor: string | undefined;
  do {
    const res = await fetch(
      cursor
        ? `${DROPBOX_API}/2/files/list_folder/continue`
        : `${DROPBOX_API}/2/files/list_folder`,
      {
        method: "POST",
        headers,
        body: cursor
          ? JSON.stringify({ cursor })
          : JSON.stringify({ path, recursive: false, limit: 1000 }),
      },
    );
    if (!res.ok) {
      throw new Error(`Dropbox list_folder failed (status ${res.status})`);
    }
    const data = (await res.json()) as ListFolderResult;
    for (const entry of data.entries ?? []) {
      if (entry[".tag"] === "folder") {
        folders.push({
          id: entry.id,
          name: entry.name,
          pathLower: entry.path_lower ?? "",
          pathDisplay: entry.path_display ?? entry.name,
        });
      }
    }
    cursor = data.has_more ? data.cursor : undefined;
  } while (cursor);

  return folders;
};
