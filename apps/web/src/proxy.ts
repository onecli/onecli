import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  IS_CLOUD,
  GOOGLE_CLIENT_ID,
  NEXTAUTH_SECRET,
  SECRET_ENCRYPTION_KEY,
} from "@/lib/env";
import { PROJECT_PATH_RE, ORG_PATH_RE } from "@/lib/navigation";

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

const DEFAULT_ORG_COOKIE = "onecli-default-org";

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

  if (!IS_CLOUD) {
    const scopeStripped = pathname
      .replace(PROJECT_PATH_RE, "")
      .replace(ORG_PATH_RE, "");
    if (scopeStripped !== pathname) {
      const url = request.nextUrl.clone();
      url.pathname = scopeStripped || "/";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  const requestHeaders = new Headers(request.headers);

  const projectId = pathname.match(PROJECT_PATH_RE)?.[1];
  if (projectId) {
    requestHeaders.set("x-project-id", projectId);
  }

  const orgId = pathname.match(ORG_PATH_RE)?.[1];
  if (orgId) {
    requestHeaders.set("x-organization-id", orgId);
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  if (orgId) {
    response.cookies.set(DEFAULT_ORG_COOKIE, orgId, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
  }

  return response;
};

export const config = {
  matcher: [
    // Match all routes except static files, _next, and api routes
    "/((?!_next/static|_next/image|favicon.ico|v1|api|.*\\.).*)",
  ],
};
