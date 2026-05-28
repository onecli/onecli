import { IS_CLOUD } from "./env";
import { getSelfUrl } from "../providers/self-url";

/**
 * Derive the public origin (scheme + host) from an incoming HTTP request.
 *
 * Trusts reverse-proxy headers (X-Forwarded-Host / X-Forwarded-Proto) so
 * this works behind nginx, Caddy, Cloudflare Tunnel, ngrok, etc.
 * Falls back to the Host header for direct access (e.g. Docker port-forward).
 */
export const getRequestOrigin = (request: Request): string => {
  if (IS_CLOUD) return getSelfUrl();

  const headers = request.headers;

  const forwardedHost = headers.get("x-forwarded-host");
  if (forwardedHost) {
    const host = forwardedHost.split(",")[0]!.trim();
    const proto =
      headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
    return `${proto}://${host}`;
  }

  const host = headers.get("host");
  if (host) {
    const proto =
      headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (request.url.startsWith("https") ? "https" : "http");
    return `${proto}://${host}`;
  }

  return getSelfUrl();
};
