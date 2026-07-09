import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  CAPS,
  IS_CLOUD,
  GOOGLE_CLIENT_ID,
  NEXTAUTH_SECRET,
  SECRET_ENCRYPTION_KEY,
} from "@/lib/env";
import { PROJECT_PATH_RE, ORG_PATH_RE } from "@/lib/navigation";
import { isConnectOnlyAllowed } from "@/lib/connect-surface";

type SetupErrorCode = "oauth-misconfigured" | "missing-encryption-key";

/**
 * Returns the first configuration error found, or null if setup is valid.
 */
const getSetupError = (): SetupErrorCode | null => {
  if (IS_CLOUD) return null;

  // NEXTAUTH_SECRET is set but Google OAuth creds are missing
  if (NEXTAUTH_SECRET && !GOOGLE_CLIENT_ID) {
    return "oauth-misconfigured";
  }

  // SECRET_ENCRYPTION_KEY is required for encrypting secrets
  if (!SECRET_ENCRYPTION_KEY) {
    return "missing-encryption-key";
  }

  return null;
};

export const proxy = (request: NextRequest) => {
  const { pathname } = request.nextUrl;

  const error = getSetupError();

  if (pathname.startsWith("/setup-error")) {
    if (!error) {
      return NextResponse.redirect(new URL("/auth/login", request.url));
    }
    return NextResponse.next();
  }

  if (error) {
    return NextResponse.redirect(
      new URL(`/setup-error?code=${error}`, request.url),
    );
  }

  // Connect-only editions (onprem-slim) expose only the app-connection surface —
  // redirect anything outside it to the connect landing.
  if (CAPS.webSurface === "connect-only" && !isConnectOnlyAllowed(pathname)) {
    return NextResponse.redirect(new URL("/app-connect", request.url));
  }

  const requestHeaders = new Headers(request.headers);

  // Scope normally comes from the URL path (/p/<id>, /org/<id>) on org-scoped
  // editions. The app-connect popup is a top-level window with no scoped path, so it
  // carries scope in the query string instead — bridge that to the same headers for
  // EVERY edition, before the flat-edition handling below. Flat editions (onprem-slim)
  // still resolve per-user projects, so the popup's ?projectId must reach the
  // downstream resolveProjectContext (which validates membership before trusting
  // either source); otherwise the connect page checks the viewer's default project and
  // wrongly reports "Configuration required" for credentials stored on the popup's
  // project.
  const { searchParams } = request.nextUrl;
  const fromQuery = pathname.startsWith("/app-connect");

  const projectId =
    pathname.match(PROJECT_PATH_RE)?.[1] ||
    (fromQuery ? searchParams.get("projectId") : null);
  if (projectId) {
    requestHeaders.set("x-project-id", projectId);
  }

  const orgId =
    pathname.match(ORG_PATH_RE)?.[1] ||
    (fromQuery ? searchParams.get("orgId") : null);
  if (orgId) {
    requestHeaders.set("x-organization-id", orgId);
  }

  // Flat editions (oss, onprem-slim) don't namespace URLs by org/project — strip any
  // /p/<id> or /org/<id> prefix (on these editions scope only ever arrives via the
  // query bridge above; the path never carries it). Org-scoped editions (cloud,
  // onprem-full) keep the path namespacing captured above.
  if (!CAPS.orgScopedUI) {
    const scopeStripped = pathname
      .replace(PROJECT_PATH_RE, "")
      .replace(ORG_PATH_RE, "");
    if (scopeStripped !== pathname) {
      const url = request.nextUrl.clone();
      url.pathname = scopeStripped || "/";
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
};

export const config = {
  matcher: [
    // Match all routes except static files, _next, and api routes
    "/((?!_next/static|_next/image|favicon.ico|v1|api|.*\\.).*)",
  ],
};
