import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { unauthorized } from "@/lib/api-utils";
import { getApp } from "@/lib/apps/registry";
import { resolveOAuthCredentials } from "@/lib/apps/resolve-credentials";
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

  const resolved = await resolveOAuthCredentials(auth.accountId, app);
  if (!resolved) {
    return NextResponse.json(
      { error: `${app.name} is not configured. Missing client credentials.` },
      { status: 400 },
    );
  }

  const redirectUri = `${APP_URL}/api/apps/${provider}/callback`;
  const scopes = app.connectionMethod.defaultScopes ?? [];
  const connectionId = request.nextUrl.searchParams.get("connectionId");
  const rawAgentName = request.nextUrl.searchParams.get("agent_name");
  const agentName = rawAgentName ? rawAgentName.slice(0, 128) : undefined;

  const state = signOAuthState({
    accountId: auth.accountId,
    provider,
    nonce: generateNonce(),
    ...(connectionId ? { connectionId } : {}),
    ...(agentName ? { agentName } : {}),
  });

  const authUrl = app.connectionMethod.buildAuthUrl({
    clientId: resolved.clientId,
    redirectUri,
    scopes,
    state,
  });

  return NextResponse.redirect(authUrl);
};
