import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { unauthorized } from "@/lib/api-utils";
import { getApp } from "@/lib/apps/registry";
import { resolveAppCredentials } from "@/lib/apps/resolve-credentials";
import { listConnectionsByProvider } from "@/lib/services/connection-service";
import { APP_URL } from "@/lib/env";
import { signOAuthState, generateNonce } from "@/lib/oauth-state";

type Params = { params: Promise<{ provider: string }> };

export const GET = async (request: NextRequest, { params }: Params) => {
  const auth = await resolveApiAuth(request);
  if (!auth) return unauthorized();

  const { provider } = await params;
  const app = getApp(provider);

  if (!app || !app.available || app.connectionMethod.type !== "oauth") {
    return NextResponse.json(
      { error: `Provider "${provider}" is not available` },
      { status: 400 },
    );
  }

  const connectionId = request.nextUrl.searchParams.get("connectionId");
  const rawAgentName = request.nextUrl.searchParams.get("agent_name");
  const agentName = rawAgentName ? rawAgentName.slice(0, 128) : undefined;

  const state = signOAuthState({
    projectId: auth.projectId,
    provider,
    nonce: generateNonce(),
    ...(connectionId ? { connectionId } : {}),
    ...(agentName ? { agentName } : {}),
  });

  const resolved = await resolveAppCredentials(auth.projectId, app);
  if (!resolved) {
    return NextResponse.json(
      { error: `${app.name} is not configured. Missing required credentials.` },
      { status: 400 },
    );
  }

  const { values: creds } = resolved;

  if (app.connectionMethod.checkExistingInstallations) {
    try {
      const redirectUrl = await app.connectionMethod.checkExistingInstallations(
        creds,
        async () => listConnectionsByProvider(auth.projectId, provider),
        `${APP_URL}/api/apps/${provider}/callback`,
        state,
      );
      if (redirectUrl) return NextResponse.redirect(redirectUrl);
    } catch {
      // Fall through to normal auth flow
    }
  }

  const redirectUri = `${APP_URL}/api/apps/${provider}/callback`;
  const scopes = app.connectionMethod.defaultScopes ?? [];

  const authUrl = app.connectionMethod.buildAuthUrl({
    appCredentials: creds,
    redirectUri,
    scopes,
    state,
  });

  return NextResponse.redirect(authUrl);
};
