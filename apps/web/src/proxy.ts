import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  IS_CLOUD,
  GOOGLE_CLIENT_ID,
  NEXTAUTH_SECRET,
  SECRET_ENCRYPTION_KEY,
} from "@/lib/env";

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

// Cloud-only: legacy unscoped dashboard routes that should redirect to their
// project-scoped equivalents. The cookie set by /p/[projectId] navigation or
// switchProjectAction is the source of truth for "active project". If the
// cookie is missing (first visit, signed out, etc.) we fall through to the
// auth flow / projects landing.
const UNSCOPED_REDIRECTS = new Set([
  "/overview",
  "/agents",
  "/connections",
  "/rules",
]);

const ACTIVE_PROJECT_COOKIE = "onecli-project-id";

const cloudUnscopedRedirect = (request: NextRequest): NextResponse | null => {
  if (!IS_CLOUD) return null;
  const { pathname } = request.nextUrl;

  // Match exact unscoped paths and their nested subroutes
  // (e.g. /connections/apps, /connections/secrets/...).
  const matchedPrefix = [...UNSCOPED_REDIRECTS].find(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (!matchedPrefix) return null;

  const projectId = request.cookies.get(ACTIVE_PROJECT_COOKIE)?.value;
  if (!projectId) return null;

  const url = request.nextUrl.clone();
  url.pathname = `/p/${projectId}${pathname}`;
  return NextResponse.redirect(url);
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

  const cloudRedirect = cloudUnscopedRedirect(request);
  if (cloudRedirect) return cloudRedirect;

  return NextResponse.next();
};

export const config = {
  matcher: [
    // Match all routes except static files, _next, and api routes
    "/((?!_next/static|_next/image|favicon.ico|api|.*\\.).*)",
  ],
};
