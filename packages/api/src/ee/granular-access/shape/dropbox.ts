import { ServiceError } from "../../../services/errors";

/**
 * Validates a Dropbox session policy. Folders are browsed live (no connect-time
 * list to check against), so we validate the shape: each entry must be an
 * absolute Dropbox path. An empty/absent list means "all folders".
 */
export const validateDropboxPolicy = async (
  _metadata: Record<string, unknown> | null,
  policy: Record<string, unknown>,
): Promise<void> => {
  const folders = policy.folders;
  if (folders === undefined) return;
  if (!Array.isArray(folders)) {
    throw new ServiceError("BAD_REQUEST", "folders must be an array");
  }
  if (folders.length === 0) return;
  if (folders.length > 100) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Too many folders selected (max 100)",
    );
  }
  for (const f of folders) {
    if (typeof f !== "string" || !f.startsWith("/") || f.length > 1024) {
      throw new ServiceError(
        "BAD_REQUEST",
        `Invalid folder path: ${String(f)}`,
      );
    }
  }
};
