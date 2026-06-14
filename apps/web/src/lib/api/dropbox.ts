import { apiGet } from "./client";
import type { DropboxFolder } from "./types";

/** Subfolders of `path` for a Dropbox connection (path "" or "/" = root). */
export const folders = (connectionId: string, path: string) =>
  apiGet<DropboxFolder[]>(
    `/v1/apps/dropbox/folders?connectionId=${encodeURIComponent(
      connectionId,
    )}&path=${encodeURIComponent(path)}`,
  );
