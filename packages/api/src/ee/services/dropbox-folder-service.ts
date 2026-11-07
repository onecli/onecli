import { ServiceError } from "../../services/errors";
import {
  loadOAuthConnection,
  PROVIDER_TIMEOUT_MS,
  validAccessToken,
  type ConnectionAccessScope,
} from "./oauth-connection-token";

const DROPBOX_API = "https://api.dropboxapi.com";

export interface DropboxFolder {
  id: string;
  name: string;
  pathLower: string;
  pathDisplay: string;
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

/**
 * Lists the subfolders of `path` for a Dropbox connection the caller may see
 * (see `loadOAuthConnection`) (path "" or "/" = account root). Follows Dropbox pagination so
 * folders with many children aren't silently truncated.
 *
 * @throws ServiceError NOT_FOUND if the connection isn't found in the org,
 *   BAD_REQUEST if no usable access token can be obtained.
 */
export const listDropboxFolders = async (
  scope: ConnectionAccessScope,
  connectionId: string,
  rawPath: string,
): Promise<DropboxFolder[]> => {
  const { conn, creds } = await loadOAuthConnection(
    scope,
    connectionId,
    "dropbox",
  );

  const token = await validAccessToken(
    conn,
    creds,
    "dropbox",
    `${DROPBOX_API}/oauth2/token`,
  );
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
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
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
