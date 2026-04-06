import { NextRequest, NextResponse } from "next/server";
import { getApp } from "@/lib/apps/registry";
import { resolveOAuthCredentials } from "@/lib/apps/resolve-credentials";
import { verifyOAuthState } from "@/lib/oauth-state";
import { upsertConnection } from "@/lib/services/connection-service";
import { logger } from "@/lib/logger";

type Params = { params: Promise<{ provider: string }> };

export const GET = async (request: NextRequest, { params }: Params) => {
  const { provider } = await params;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:10254";
  const errorRedirect = (msg: string) =>
    NextResponse.redirect(
      `${appUrl}/app-connect/${provider}?status=error&message=${encodeURIComponent(msg)}`,
    );

  try {
    const app = getApp(provider);
    if (!app || app.connectionMethod.type !== "oauth") {
      return errorRedirect("Invalid provider");
    }

    const code = request.nextUrl.searchParams.get("code");
    const stateParam = request.nextUrl.searchParams.get("state");

    if (!code || !stateParam) {
      return errorRedirect("Missing code or state parameter");
    }

    const state = verifyOAuthState(stateParam);
    if (!state || state.provider !== provider) {
      return errorRedirect("Invalid state parameter");
    }

    const resolved = await resolveOAuthCredentials(state.accountId, app);
    if (!resolved) {
      return errorRedirect("Provider not configured");
    }

    const redirectUri = `${appUrl}/api/apps/${provider}/callback`;

    const { credentials, scopes, metadata } =
      await app.connectionMethod.exchangeCode({
        code,
        clientId: resolved.clientId,
        clientSecret: resolved.clientSecret,
        redirectUri,
      });

    await upsertConnection(state.accountId, provider, credentials, {
      scopes,
      metadata,
    });

    return NextResponse.redirect(
      `${appUrl}/app-connect/${provider}?status=success`,
    );
  } catch (err) {
    logger.error({ err, provider }, "OAuth callback failed");
    const message =
      err instanceof Error ? err.message : "An unexpected error occurred";
    return errorRedirect(message);
  }
};
