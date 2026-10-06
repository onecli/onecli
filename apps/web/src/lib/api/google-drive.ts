import { apiGet } from "./client";
import type { GoogleDriveFolder } from "./types";

/** Subfolders of `parentId` for a Google Drive connection ("" = the top level:
 * My Drive's root folders plus shared drives). */
export const folders = (connectionId: string, parentId: string) =>
  apiGet<GoogleDriveFolder[]>(
    `/v1/apps/google-drive/folders?connectionId=${encodeURIComponent(
      connectionId,
    )}${parentId ? `&parentId=${encodeURIComponent(parentId)}` : ""}`,
  );

/** Display names for folder IDs (null = not visible to the connection). */
export const folderNames = (connectionId: string, ids: string[]) =>
  apiGet<Record<string, string | null>>(
    `/v1/apps/google-drive/folder-names?connectionId=${encodeURIComponent(
      connectionId,
    )}&ids=${encodeURIComponent(ids.join(","))}`,
  );
