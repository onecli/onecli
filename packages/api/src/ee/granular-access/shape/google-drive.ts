import { ServiceError } from "../../../services/errors";

/** Drive file IDs: URL-safe base64-ish. Mirrors `valid_id` in the gateway's
 * `google_drive.rs`; anything else could never be verified there. */
export const DRIVE_ID = /^[A-Za-z0-9_-]{1,256}$/;
/** Drive nests folders at most 100 deep, so no real chain is longer — and the
 * gateway's ancestry walk covers exactly that depth. */
const MAX_CHAIN_DEPTH = 100;
/** IDs one folder-names request resolves (each costs up to two Drive calls).
 * A saved policy can name far more, so the picker asks in batches of this. */
export const MAX_NAME_LOOKUPS = 200;

/**
 * Validates a Google Drive session policy. Folders are browsed live (no
 * connect-time list to check against), so we validate the shape: each entry is
 * a chain of Drive folder IDs (`<id>/<id>/…`) from the top of a drive down to
 * the selected folder. An absent list means "all folders".
 */
export const validateGoogleDrivePolicy = async (
  _metadata: Record<string, unknown> | null,
  policy: Record<string, unknown>,
): Promise<void> => {
  const chains = policy.driveFolders;
  if (chains === undefined) return;
  if (!Array.isArray(chains)) {
    throw new ServiceError("BAD_REQUEST", "driveFolders must be an array");
  }
  if (chains.length === 0) return;
  if (chains.length > 100) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Too many folders selected (max 100)",
    );
  }
  for (const chain of chains) {
    const ids = typeof chain === "string" ? chain.split("/") : [];
    if (
      ids.length === 0 ||
      ids.length > MAX_CHAIN_DEPTH ||
      !ids.every((id) => DRIVE_ID.test(id))
    ) {
      throw new ServiceError(
        "BAD_REQUEST",
        `Invalid Google Drive folder: ${String(chain)}`,
      );
    }
  }
};
