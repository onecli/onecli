import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { unauthorized } from "@/lib/api-utils";
import { getApp } from "@/lib/apps/registry";
import { resolveAppCredentials } from "@/lib/apps/resolve-credentials";
import { tryHandleOrgAuthorize } from "@/lib/apps/oauth-org";
import { APP_URL } from "@/lib/env";
import { signOAuthState, generateNonce } from "@/lib/oauth-state";

type Params = { params: Promise<{ provider: string }> };

export const GET = async (request: NextRequest, { params }: Params) => {
  const { provider } = await params;

  const orgResponse = await tryHandleOrgAuthorize(request, provider);
  if (orgResponse) return orgResponse;

  const auth = await resolveApiAuth(request);
  if (!auth) return unauthorized();

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

  const redirectUri = `${APP_URL}/api/apps/${provider}/callback`;
  const scopes = app.connectionMethod.defaultScopes ?? [];

  const authUrl = app.connectionMethod.buildAuthUrl({
    appCredentials: creds,
    redirectUri,
    scopes,
    state,
  });

  const response = NextResponse.redirect(authUrl);
  response.cookies.set("oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: `/api/apps/${provider}/callback`,
    maxAge: 600,
  });
  return response;
};
