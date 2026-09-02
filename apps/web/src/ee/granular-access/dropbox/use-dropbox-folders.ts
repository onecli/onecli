import { useQuery } from "@tanstack/react-query";
import { dropbox } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/**
 * Lists the subfolders of `path` for a Dropbox connection (path "" = root).
 * Backed by the cloud-only `/v1/apps/dropbox/folders` route, which decrypts the
 * connection's token (refreshing if needed) and calls Dropbox.
 */
export const useDropboxFolders = (
  connectionId: string,
  path: string,
  enabled: boolean,
) =>
  useQuery({
    queryKey: queryKeys.dropbox.folders(connectionId, path),
    queryFn: () => dropbox.folders(connectionId, path),
    enabled: enabled && connectionId.length > 0,
    staleTime: 60_000,
  });
