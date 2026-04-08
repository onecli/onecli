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

  return NextResponse.next();
};

export const config = {
  matcher: [
    // Match all routes except static files, _next, and api routes
    "/((?!_next/static|_next/image|favicon.ico|api|.*\\.).*)",
  ],
};
