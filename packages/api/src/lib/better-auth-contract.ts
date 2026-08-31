/**
 * The self-hosted session contract: the few constants that three independent
 * implementations must agree on, byte for byte.
 *
 * - the api-server, which mounts better-auth and issues the cookie
 * - the browser client, which calls that mount
 * - the Rust gateway, which validates the same cookie on its own
 *   (`apps/gateway/crates/context/src/auth.rs` — it cannot import this, so it hardcodes the
 *   matching values and its tests pin them against a real cookie)
 *
 * Deliberately free of imports: this module is reachable from client bundles,
 * so it must never pull in the database, the secret, or better-auth itself.
 */

/**
 * Where the auth handler is mounted, relative to the API origin.
 *
 * NOT better-auth's `/api/auth` default: the api-server serves a legacy
 * `/api/*` → `/v1/*` rewrite (which still answers for old CLI builds), so the
 * default path would be shadowed by it and collide with our own
 * `/v1/auth/session`. `/auth` cannot collide with anything the api-server
 * already serves.
 */
export const BETTER_AUTH_BASE_PATH = "/auth";

/**
 * The cookie prefix. Pinned rather than inherited so the cookie name is a
 * constant of this deployment rather than a function of the app name or a
 * library default that a future version could change.
 */
export const BETTER_AUTH_COOKIE_PREFIX = "better-auth";

/**
 * The session cookie names, most specific first: browsers get the `__Secure-`
 * variant on HTTPS deployments and the bare name otherwise, so any validator
 * has to accept both.
 */
export const SESSION_COOKIE_NAMES = [
  `__Secure-${BETTER_AUTH_COOKIE_PREFIX}.session_token`,
  `${BETTER_AUTH_COOKIE_PREFIX}.session_token`,
] as const;

/**
 * Marks an `externalAuthId` this deployment's own identity layer minted.
 *
 * Every identity source is distinguishable by its prefix — Cognito writes a
 * provider subject, the retired local mode wrote a fixed literal — so a row's
 * origin can be told from the value alone. The upgrade path relies on that to
 * refuse to touch a user it did not create.
 */
export const BETTER_AUTH_ID_PREFIX = "ba:";

/**
 * Read our `externalAuthId` off a better-auth user.
 *
 * That — not better-auth's own row id — is the identity every other part of
 * the system resolves a user by (the API middleware, the gateway), so it is
 * what a session must yield. It is declared as an additional field and
 * stamped on every row at creation, but better-auth types its user from the
 * core schema alone, so the value arrives untyped: parse it rather than
 * assert a shape, and treat a row without one as not signed in instead of
 * inventing an identity for it.
 */
export const readExternalAuthId = (user: object): string | null => {
  const value = (user as Record<string, unknown>).externalAuthId;
  return typeof value === "string" && value.length > 0 ? value : null;
};
