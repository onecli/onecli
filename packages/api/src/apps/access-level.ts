import type { ConnectionMethod } from "./types";
import { getApp } from "./registry";

type OAuthMethod = Extract<ConnectionMethod, { type: "oauth" }>;

/**
 * Resolve the access level an OAuth connect should use.
 *
 * - App without `accessLevels`: always `{ ok: true, value: undefined }`, so the
 *   query param is ignored and existing providers are untouched.
 * - Nothing requested: the app's `defaultValue`.
 * - A requested value outside the app's declared options: rejected, so a
 *   hand-crafted URL can never smuggle an arbitrary value into the provider's
 *   authorize URL.
 */
export const resolveAccessLevel = (
  method: OAuthMethod,
  requested: string | undefined,
): { ok: true; value: string | undefined } | { ok: false; error: string } => {
  const levels = method.accessLevels;
  if (!levels) return { ok: true, value: undefined };
  if (requested === undefined || requested === "") {
    return { ok: true, value: levels.defaultValue };
  }
  if (!levels.options.some((o) => o.value === requested)) {
    return { ok: false, error: "Unsupported access level" };
  }
  return { ok: true, value: requested };
};

/** The access level carried in a verified OAuth state, re-validated against
 *  the app so a state minted before a level was removed can't pass it on. */
export const accessLevelFromState = (
  method: OAuthMethod,
  stateValue: unknown,
): string | undefined => {
  const levels = method.accessLevels;
  if (!levels) return undefined;
  return typeof stateValue === "string" &&
    levels.options.some((o) => o.value === stateValue)
    ? stateValue
    : levels.defaultValue;
};

/**
 * The label of the level a connection holds (`metadata.accessLevel`, which the
 * code exchange records), for the connection's account card. `null` for apps
 * without levels, and for connections made before the level was recorded.
 */
export const connectionAccessLevelLabel = (
  provider: string,
  metadata: Record<string, unknown> | null,
): string | null => {
  const method = getApp(provider)?.connectionMethod;
  if (method?.type !== "oauth") return null;
  const stored = metadata?.accessLevel;
  return (
    method.accessLevels?.options.find((o) => o.value === stored)?.label ?? null
  );
};
