import { ServiceError } from "../../services/errors";
import {
  DRIVE_ID,
  MAX_NAME_LOOKUPS,
} from "../granular-access/shape/google-drive";
import {
  loadOAuthConnection,
  PROVIDER_TIMEOUT_MS,
  validAccessToken,
  type ConnectionAccessScope,
} from "./oauth-connection-token";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Pagination guard: a picker never needs more than this per level. */
const MAX_ITEMS = 2000;

export interface GoogleDriveFolder {
  id: string;
  name: string;
  /** `sharedDrive` = a shared drive's root (only listed at the top level). */
  kind: "folder" | "sharedDrive";
  /** Direct children, for the picker's "3 folders · 12 files" hint. `null`
   * when the count couldn't be taken (it never fails the listing). With
   * `countCapped`, only the first page was counted: both are LOWER bounds. */
  subfolderCount: number | null;
  fileCount: number | null;
  countCapped: boolean;
}

/** Children counted per folder: one page, which Drive caps at 1000 and may
 * return short of it. More pages = `countCapped`. */
const COUNT_PAGE_SIZE = 1000;
/** Folders per level that get counts, and how many count calls run at once. */
const MAX_COUNTED = 200;
const COUNT_CONCURRENCY = 8;

interface FilesListResult {
  files?: { id?: string; name?: string }[];
  nextPageToken?: string;
}

interface DrivesListResult {
  drives?: { id?: string; name?: string }[];
  nextPageToken?: string;
}

interface ChildCounts {
  subfolderCount: number | null;
  fileCount: number | null;
  countCapped: boolean;
}

const UNKNOWN: ChildCounts = {
  subfolderCount: null,
  fileCount: null,
  countCapped: false,
};

/** One Drive API call as the connection, bounded in time. */
const driveFetch = (token: string, path: string): Promise<Response> =>
  fetch(`${DRIVE_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

/** The connection's access token, refreshed when expired. */
const driveToken = async (
  scope: ConnectionAccessScope,
  connectionId: string,
): Promise<string> => {
  const { conn, creds } = await loadOAuthConnection(
    scope,
    connectionId,
    "google-drive",
  );
  const token = await validAccessToken(
    conn,
    creds,
    "google-drive",
    GOOGLE_TOKEN_URL,
  );
  if (!token) {
    throw new ServiceError("BAD_REQUEST", "No valid Google Drive access token");
  }
  return token;
};

/** One cheap call per folder: the first page of its children's mime types. */
const countChildren = async (
  token: string,
  folderId: string,
): Promise<ChildCounts> => {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "nextPageToken,files(mimeType)",
    pageSize: String(COUNT_PAGE_SIZE),
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    corpora: "allDrives",
  });
  try {
    const res = await driveFetch(token, `/files?${params}`);
    if (!res.ok) return UNKNOWN;
    const page = (await res.json()) as {
      files?: { mimeType?: string }[];
      nextPageToken?: string;
    };
    const files = page.files ?? [];
    const subfolderCount = files.filter(
      (f) => f.mimeType === FOLDER_MIME,
    ).length;
    return {
      subfolderCount,
      fileCount: files.length - subfolderCount,
      countCapped: Boolean(page.nextPageToken),
    };
  } catch {
    return UNKNOWN;
  }
};

/** Map with bounded concurrency, preserving order. */
const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
};

const fetchPaged = async <T extends { nextPageToken?: string }>(
  token: string,
  path: (pageToken?: string) => string,
  collect: (page: T) => number,
): Promise<void> => {
  let pageToken: string | undefined;
  let total = 0;
  do {
    const res = await driveFetch(token, path(pageToken));
    if (!res.ok) {
      throw new Error(`Google Drive list failed (status ${res.status})`);
    }
    const page = (await res.json()) as T;
    total += collect(page);
    pageToken = page.nextPageToken;
  } while (pageToken && total < MAX_ITEMS);
};

/**
 * Lists the subfolders of `parentId` for a Google Drive connection the caller
 * may see (see `loadOAuthConnection`). With no `parentId`, lists the top level: My Drive's
 * root folders followed by the shared drives the account can see.
 *
 * The picker turns the browsed trail into the policy's folder-ID chain; the
 * gateway re-verifies that chain against Drive's live parent links on every
 * agent request, so nothing here is trusted for enforcement.
 *
 * @throws ServiceError NOT_FOUND if the connection isn't found in the org,
 *   BAD_REQUEST for an invalid parent ID or when no usable token exists.
 */
export const listGoogleDriveFolders = async (
  scope: ConnectionAccessScope,
  connectionId: string,
  parentId: string | undefined,
): Promise<GoogleDriveFolder[]> => {
  if (parentId !== undefined && !DRIVE_ID.test(parentId)) {
    // Interpolated into the Drive query below — never let it carry quotes.
    throw new ServiceError("BAD_REQUEST", "Invalid folder id");
  }
  const token = await driveToken(scope, connectionId);

  const folders: Omit<GoogleDriveFolder, keyof ChildCounts>[] = [];
  const q = `'${parentId ?? "root"}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
  await fetchPaged<FilesListResult>(
    token,
    (pageToken) => {
      const params = new URLSearchParams({
        q,
        fields: "nextPageToken,files(id,name)",
        orderBy: "folder,name_natural",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        corpora: parentId ? "allDrives" : "user",
      });
      if (pageToken) params.set("pageToken", pageToken);
      return `/files?${params}`;
    },
    (page) => {
      for (const f of page.files ?? []) {
        if (f.id && DRIVE_ID.test(f.id)) {
          folders.push({ id: f.id, name: f.name ?? f.id, kind: "folder" });
        }
      }
      return page.files?.length ?? 0;
    },
  );

  if (parentId === undefined) {
    await fetchPaged<DrivesListResult>(
      token,
      (pageToken) => {
        const params = new URLSearchParams({
          fields: "nextPageToken,drives(id,name)",
          pageSize: "100",
        });
        if (pageToken) params.set("pageToken", pageToken);
        return `/drives?${params}`;
      },
      (page) => {
        for (const d of page.drives ?? []) {
          if (d.id && DRIVE_ID.test(d.id)) {
            folders.push({
              id: d.id,
              name: d.name ?? d.id,
              kind: "sharedDrive",
            });
          }
        }
        return page.drives?.length ?? 0;
      },
    );
  }

  const counts = await mapLimit(
    folders.slice(0, MAX_COUNTED),
    COUNT_CONCURRENCY,
    (f) => countChildren(token, f.id),
  );
  return folders.map((f, i) => ({ ...f, ...(counts[i] ?? UNKNOWN) }));
};

/**
 * Display names for folder IDs (the picker labels saved chains with these).
 * A shared drive's ID is also its root folder's ID, and that root folder's
 * file name is not the drive's name, so a file whose `driveId` is its own ID
 * is labeled with the drive's name (`drives.get`) — the name the picker
 * listed it under. An ID `files.get` can't see is tried as a shared drive; one
 * the account can't see at all maps to `null` rather than failing the lookup.
 *
 * @throws ServiceError NOT_FOUND if the connection isn't found in the org,
 *   BAD_REQUEST for invalid/too many IDs or when no usable token exists.
 */
export const resolveGoogleDriveFolderNames = async (
  scope: ConnectionAccessScope,
  connectionId: string,
  ids: string[],
): Promise<Record<string, string | null>> => {
  const unique = [...new Set(ids)];
  if (
    unique.length > MAX_NAME_LOOKUPS ||
    !unique.every((id) => DRIVE_ID.test(id))
  ) {
    throw new ServiceError("BAD_REQUEST", "Invalid folder ids");
  }
  if (unique.length === 0) return {};
  const token = await driveToken(scope, connectionId);
  const get = async (
    path: string,
  ): Promise<{ name?: unknown; driveId?: unknown } | null> => {
    try {
      const res = await driveFetch(token, path);
      return res.ok ? ((await res.json()) as object) : null;
    } catch {
      return null;
    }
  };
  const driveName = async (id: string): Promise<string | null> => {
    const drive = await get(`/drives/${id}?fields=name`);
    return typeof drive?.name === "string" ? drive.name : null;
  };
  const entries = await mapLimit(unique, COUNT_CONCURRENCY, async (id) => {
    const file = await get(
      `/files/${id}?fields=name,driveId&supportsAllDrives=true`,
    );
    if (file === null || file.driveId === id) {
      return [id, await driveName(id)] as const;
    }
    return [id, typeof file.name === "string" ? file.name : null] as const;
  });
  return Object.fromEntries(entries);
};
