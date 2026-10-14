import { ApiError } from "@/lib/api/client";

/**
 * Toast text for a failed app-config write. Saving, removing, or toggling an
 * OAuth client config is admin/owner-only (it overrides the client for every
 * app of that vendor), so a member gets a clear reason instead of a generic
 * failure.
 */
export const appConfigErrorMessage = (err: unknown, fallback: string) =>
  err instanceof ApiError && err.status === 403
    ? "Only organization admins can change OAuth credentials. Ask an admin to set this up."
    : fallback;
