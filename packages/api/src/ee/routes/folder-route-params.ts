import type { Context } from "hono";
import { ServiceError } from "../../services/errors";

/**
 * The `connectionId` query parameter every live folder-browsing route needs.
 * Thrown as a `ServiceError`, so a missing one reaches the client in the
 * app-wide error shape like every other bad input.
 *
 * @throws ServiceError BAD_REQUEST when absent or empty.
 */
export const requiredConnectionId = (c: Context): string => {
  const connectionId = c.req.query("connectionId");
  if (!connectionId) {
    throw new ServiceError("BAD_REQUEST", "connectionId is required");
  }
  return connectionId;
};
