import { IS_CLOUD } from "./env";
import { getSelfUrl } from "../providers/self-url";
import {
  configuredApiUrl,
  configuredAppUrl,
  normalizeOrigin,
  originFromHeaders,
} from "./app-origin";
import { trustedBrowserOrigin } from "./public-origins";

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
 * this only as the fallback; one that needs the **API** origin for an OAuth
 * redirect URI must use `getApiCallbackOrigin`; see `routes/apps.ts`.
 */
const headerOrigin = (request: Request): string | undefined =>
  originFromHeaders(
    request.headers,
    request.url.startsWith("https") ? "https" : "http",
  );

export const getRequestOrigin = (request: Request): string => {
  if (IS_CLOUD) return getSelfUrl();

  return headerOrigin(request) ?? getSelfUrl();
};

/**
 * Origin to build an OAuth `redirect_uri` from — a `/v1` URL the provider
 * calls back, served by the **api-server** in every edition.
 *
 * Not `getAppOrigin`: `APP_URL` names the dashboard, which serves no `/v1`, so
 * a redirect URI built from it dies in a deployment that splits the two hosts
 * (the self-host compose does). And not bare `getRequestOrigin`: an explicitly
 * configured `API_URL` must win over the request's own headers so the redirect
 * URI stays stable behind a proxy — providers match it against an exact,
 * pre-registered value. On cloud the api-server pins its own address via
 * `selfUrl`, which is the same answer with no env read.
 *
 * Both legs of the flow — `/authorize` building the consent URL and the
 * callback rebuilding the URI for the token exchange — must resolve this
 * identically, or the exchange fails; they do by both calling this.
 */
export const getApiCallbackOrigin = (request: Request): string => {
  if (IS_CLOUD) return getSelfUrl();

  return configuredApiUrl() ?? headerOrigin(request) ?? getSelfUrl();
};

/**
 * The browser's own origin when — and only when — it is one this deployment
 * already trusts ([`trustedBrowserOrigin`]'s set: the app origin and its
 * loopback twin, any `ONECLI_TRUSTED_ORIGINS` extras, the split-host api
 * origin).
 *
 * Why it exists: on an UNCONFIGURED install the dashboard's address is
 * unknowable from a request answered on the API origin — the browser
 * navigated here (`/authorize` is a top-level navigation from the connect
 * page), so its `Referer` names the dashboard. A referer is
 * cross-site-influenceable (SameSite=Lax still sends the session cookie on a
 * top-level GET), which is why an UNLISTED referer is ignored rather than
 * honored — an attacker's page can never steer the post-consent landing to
 * an origin the operator doesn't already serve. At the OAuth callback the
 * referer is the provider's own origin, never trusted, so this step is inert
 * there by construction.
 */
const trustedRefererOrigin = (request: Request): string | undefined => {
  const referer = request.headers.get("referer");
  if (!referer) return undefined;
  try {
    return trustedBrowserOrigin(new URL(referer).origin);
  } catch {
    return undefined;
  }
};

/**
 * Origin to send a **browser** to for a dashboard page (`/app-connect/*`, …).
 *
 * Not the same question as `getRequestOrigin`: whoever answered the request is
 * not necessarily who serves the dashboard. A deployment that splits the API
 * and the dashboard across hosts answers this on the API origin while the pages
 * live on another, so an explicitly configured `APP_URL` always wins; only an
 * unconfigured deployment — the self-hosted default — falls back to the
 * browser's own (trusted) referer, then the origin the request arrived on.
 * The referer step is what lands a zero-config install's OAuth connect back
 * on the DASHBOARD instead of on this api-server's JSON 404: the request
 * origin here is the API origin, which serves no pages.
 *
 * Reach for this, not `getRequestOrigin`, whenever the result becomes a
 * `Location` header or a link a human will click.
 *
 * `signedOrigin` is an origin recovered from data we signed earlier in the same
 * flow — the OAuth state minted at the authenticated `/authorize`. Preferring it
 * over the request-time headers matters because the OAuth *callback* is
 * unauthenticated: taking the answer decided at the trusted end keeps a forged
 * `X-Forwarded-Host` on the callback from steering where the browser lands. It
 * still loses to a configured `APP_URL`, which is the only thing that can be
 * right when the API and the dashboard are on different hosts. Absent,
 * unparseable, or signed by a release that predates it, it drops out and the
 * behavior is exactly as before.
 */
export const getAppOrigin = (
  request: Request,
  signedOrigin?: unknown,
): string =>
  configuredAppUrl() ??
  normalizeOrigin(signedOrigin) ??
  trustedRefererOrigin(request) ??
  getRequestOrigin(request);
