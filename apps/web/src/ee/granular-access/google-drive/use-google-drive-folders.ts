import { useQuery } from "@tanstack/react-query";
import { MAX_NAME_LOOKUPS } from "@onecli/api/ee/granular-access/shape/google-drive";
import { googleDrive } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/**
 * Lists the subfolders of `parentId` for a Google Drive connection ("" = top
 * level). Backed by the cloud-only `/v1/apps/google-drive/folders` route.
 */
export const useGoogleDriveFolders = (
  connectionId: string,
  parentId: string,
  enabled: boolean,
) =>
  useQuery({
    queryKey: queryKeys.googleDrive.folders(connectionId, parentId),
    queryFn: () => googleDrive.folders(connectionId, parentId),
    enabled: enabled && connectionId.length > 0,
    staleTime: 60_000,
  });

/**
 * Display names for the folder IDs in saved chains. A policy can name more
 * IDs than one lookup resolves (100 chains, each up to 100 deep), so they are
 * asked for in batches the route accepts.
 */
export const useGoogleDriveFolderNames = (
  connectionId: string,
  ids: string[],
) => {
  const key = [...new Set(ids)].sort().join(",");
  return useQuery({
    queryKey: queryKeys.googleDrive.folderNames(connectionId, key),
    queryFn: async () => {
      const unique = key ? key.split(",") : [];
      const batches: string[][] = [];
      for (let i = 0; i < unique.length; i += MAX_NAME_LOOKUPS) {
        batches.push(unique.slice(i, i + MAX_NAME_LOOKUPS));
      }
      const results = await Promise.all(
        batches.map((batch) => googleDrive.folderNames(connectionId, batch)),
      );
      return Object.fromEntries(results.flatMap((r) => Object.entries(r)));
    },
    enabled: connectionId.length > 0 && key.length > 0,
    staleTime: 5 * 60_000,
  });
};
