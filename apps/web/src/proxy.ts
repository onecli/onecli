import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isMissingSessionSecret } from "@onecli/api/lib/session-secret";
import { getApiInternalUrl } from "@onecli/api/lib/env";
import { IS_CLOUD, SECRET_ENCRYPTION_KEY } from "@/lib/env";
import { buildCsp, createCspNonce } from "@/lib/csp";
import { WORKSPACE_PATH_RE, ORG_PATH_RE } from "@/lib/navigation";

type SetupErrorCode = "missing-auth-secret" | "missing-encryption-key";

/**
 * Returns the first configuration error found, or null if setup is valid.
 *
 * Google is deliberately NOT checked. Email and password is the floor on a
 * self-hosted deployment and Google is an extra button when it is configured,
 * so "no Google credentials" describes most installs rather than a fault.
 */
const getSetupError = (): SetupErrorCode | null => {
  if (IS_CLOUD) return null;

  // Nothing can sign a session. Reported here because otherwise the first
  // symptom is an unhandled error on every page: the identity layer refuses
  // to build without a secret.
  if (isMissingSessionSecret()) {
    return "missing-auth-secret";
  }

  // SECRET_ENCRYPTION_KEY is required for encrypting secrets
  if (!SECRET_ENCRYPTION_KEY) {
    return "missing-encryption-key";
  }

  return null;
};

/**
 * The dashboard's own pages under `/auth/*`, which must KEEP the setup-error
 * redirect below: they render HTML, and the setup screen is exactly the right
 * answer on a misconfigured install. Everything else under `/auth/` (and all
 * of `/v1/`, `/gw/`) is API surface the dev server proxies to the api-server
 * and gateway (`next.config.js` rewrites) — this middleware runs BEFORE those
 * rewrites, and their callers expect JSON or better-auth's own responses, not
 * a 307 to an HTML page; the API reports its own configuration errors.
 *
 * A prefix here covers its subroutes (`/auth/login` covers `/auth/login/sso`).
 * `proxy.test.ts` pins this list against the filesystem router, so a new
 * `/auth/<page>` cannot silently lose its setup gate.
 */
export const WEB_AUTH_PAGES = [
  "/auth/login",
  "/auth/signup",
  "/auth/cli",
  "/auth/forgot-password",
  "/auth/reset-password",
];

const isWebAuthPage = (pathname: string): boolean =>
  WEB_AUTH_PAGES.some(
    (page) => pathname === page || pathname.startsWith(`${page}/`),
  );

/**
 * A page load, in the sense an edge router would use: only `GET`/`HEAD` can
 * render a dashboard page. Anything else on one of those paths is a form
 * submit meant for the api (`apiFormSubmitOnPagePath`).
 */
const isPageLoad = (method: string): boolean =>
  method === "GET" || method === "HEAD";

/**
 * The api shares its path namespace with the dashboard's pages under
 * `/auth`: better-auth answers `POST /auth/reset-password` while the
 * dashboard renders `GET /auth/reset-password`. Every edge in front of a
 * self-host (Caddy, nginx, an Ingress, a Gateway API route) would otherwise
 * need a method-aware rule to split the two, and most cannot express one
 * (Ingress matches on path only). So the dashboard takes the whole page path
 * and forwards the non-page-load methods to the api itself, server-side,
 * over `API_INTERNAL_URL`. The browser never sees the hop: it posted to the
 * dashboard origin, and the api's response (set-cookie included) comes back
 * through the same connection. Self-host only: cloud's auth is Cognito and
 * has no better-auth endpoint to forward to.
 *
 * Only the exact page paths are forwarded, never their subroutes: a
 * subroute under a page (`/auth/login/sso`) is also a dashboard page, and
 * the api's own `/auth/reset-password/<token>` is not a page at all (it is
 * routed to the api by `isProxiedApiPath` before this is consulted).
 */
const apiFormSubmitOnPagePath = (request: NextRequest): URL | null => {
  if (IS_CLOUD || isPageLoad(request.method)) return null;
  const { pathname } = request.nextUrl;
  if (!WEB_AUTH_PAGES.includes(pathname)) return null;
  const target = new URL(getApiInternalUrl());
  target.pathname = pathname;
  target.search = request.nextUrl.search;
  return target;
};

const isProxiedApiPath = (pathname: string): boolean => {
  if (pathname.startsWith("/v1/") || pathname.startsWith("/gw/")) return true;
  return pathname.startsWith("/auth/") && !isWebAuthPage(pathname);
};

export const proxy = (request: NextRequest) => {
  const { pathname } = request.nextUrl;

  // First: a form submit on one of the dashboard's own page paths is api
  // surface, like `/v1` and the rest of `/auth`. It bypasses the setup gate
  // (the api reports its own configuration errors to a form client; a 307 to
  // an HTML setup page is not a response one can use) and carries none of
  // the scope/CSP work below, which belongs on dashboard renders only.
  const apiTarget = apiFormSubmitOnPagePath(request);
  if (apiTarget) {
    return NextResponse.rewrite(apiTarget);
  }

  const error = getSetupError();

  if (pathname.startsWith("/setup-error")) {
    if (!error) {
      return NextResponse.redirect(new URL("/auth/login", request.url));
    }
    return NextResponse.next();
  }

  if (error && !isProxiedApiPath(pathname)) {
    return NextResponse.redirect(
      new URL(`/setup-error?code=${error}`, request.url),
    );
  }

  const requestHeaders = new Headers(request.headers);

  // Scope normally comes from the URL path (/w/<id>, /org/<id>). The app-connect
  // popup is a top-level window with no scoped path, so it carries scope in the
  // query string instead — bridge that to the same headers; the popup's
  // ?workspaceId must reach the downstream resolveWorkspaceContext (which validates
  // membership before trusting either source), otherwise the connect page checks
  // the viewer's default workspace and wrongly reports "Configuration required"
  // for credentials stored on the popup's workspace.
  const { searchParams } = request.nextUrl;
  const fromQuery = pathname.startsWith("/app-connect");

  const workspaceId =
    pathname.match(WORKSPACE_PATH_RE)?.[1] ||
    (fromQuery ? searchParams.get("workspaceId") : null);
  if (workspaceId) {
    requestHeaders.set("x-workspace-id", workspaceId);
  }

  const orgId =
    pathname.match(ORG_PATH_RE)?.[1] ||
    (fromQuery ? searchParams.get("orgId") : null);
  if (orgId) {
    requestHeaders.set("x-organization-id", orgId);
  }

  // Never trust an inbound x-nonce: the layout stamps it into script tags,
  // so only the value minted below may reach it (cloud overwrites; onprem
  // must not let a client-supplied one through).
  requestHeaders.delete("x-nonce");

  // Cloud: per-request nonce CSP (OC-01). The header must be on the
  // FORWARDED REQUEST — Next.js parses it during SSR and stamps the nonce
  // onto every script it emits — and mirrored onto the response so the
  // browser enforces the same policy. `x-nonce` hands the value to server
  // components (the layout) for scripts Next does not own. Onprem keeps its
  // current no-CSP behavior; adding one there is a follow-up with its own
  // design (self-host origins are runtime-configured).
  if (IS_CLOUD) {
    const nonce = createCspNonce();
    const csp = buildCsp(nonce);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("content-security-policy", csp);

    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    response.headers.set("content-security-policy", csp);
    return response;
  }

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
};

export const config = {
  matcher: [
    // Match all routes except static files and _next. The dashboard serves
    // no API surface of its own: /v1 lives on the api-server, and sign-in
    // moved there with it.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.).*)",
  ],
};
