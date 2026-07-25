import { IS_CLOUD } from "./env";
import { getSelfUrl } from "../providers/self-url";
import { configuredAppUrl, originFromHeaders } from "./app-origin";

/**
 * Derive the public origin (scheme + host) from an incoming HTTP request.
 *
 * Trusts reverse-proxy headers (X-Forwarded-Host / X-Forwarded-Proto) so
 * this works behind nginx, Caddy, Cloudflare Tunnel, ngrok, etc.
 * Falls back to the Host header for direct access (e.g. Docker port-forward).
 *
 * This answers "which origin served *this* request" — which on cloud is the API
 * domain, not the dashboard's. A call site that needs the **app** origin
 * (somewhere to send a browser) must start from `configuredAppUrl()` and use
 * this only as the fallback; see `routes/apps.ts`.
 */
export const getRequestOrigin = (request: Request): string => {
  if (IS_CLOUD) return getSelfUrl();

  // Self-hosted: honor an explicitly configured public URL (APP_URL) so OAuth
  // redirect URIs stay stable behind a proxy — matches the Public URL shown in
  // Settings → Instance. `configuredAppUrl()` is undefined when unset, so
  // default deploys keep the header-derived behavior below.
  const configured = configuredAppUrl();
  if (configured) return configured;

  return (
    originFromHeaders(
      request.headers,
      request.url.startsWith("https") ? "https" : "http",
    ) ?? getSelfUrl()
  );
};

/**
 * Origin to send a **browser** to for a dashboard page (`/app-connect/*`, …).
 *
 * Not the same question as `getRequestOrigin`: whoever answered the request is
 * not necessarily who serves the dashboard. A deployment that splits the API
 * and the dashboard across hosts answers this on the API origin while the pages
 * live on another, so an explicitly configured `APP_URL` always wins; only an
 * unconfigured deployment — the self-hosted default — falls back to the origin
 * the request arrived on.
 *
 * Reach for this, not `getRequestOrigin`, whenever the result becomes a
 * `Location` header or a link a human will click.
 */
export const getAppOrigin = (request: Request): string =>
  configuredAppUrl() ?? getRequestOrigin(request);
