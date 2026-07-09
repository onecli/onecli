/**
 * The web paths a connect-only edition (onprem-slim) serves — just the app-connection
 * flow and its prerequisites (login, the connect landing + per-app pages, setup errors).
 * The middleware (proxy.ts) redirects anything outside this set to /app-connect.
 *
 * `/v1` and `/api` are already exempt from the middleware matcher, so they don't need to
 * be listed here. Pure + edge-safe (string logic only).
 */
const CONNECT_ONLY_PREFIXES = ["/auth", "/app-connect", "/setup-error"];

export const isConnectOnlyAllowed = (pathname: string): boolean => {
  if (pathname === "/") return true;
  return CONNECT_ONLY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
};
