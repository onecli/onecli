import { NextRequest, NextResponse } from "next/server";
import { getApp } from "@/lib/apps/registry";
import { resolveAppCredentials } from "@/lib/apps/resolve-credentials";
import { APP_URL } from "@/lib/env";
import { invalidateGatewayCacheForAccount } from "@/lib/gateway-invalidate";
import { verifyOAuthState } from "@/lib/oauth-state";
import {
  createConnection,
  reconnectConnection,
  listConnectionsByProvider,
  extractLabel,
} from "@/lib/services/connection-service";
import { logger } from "@/lib/logger";

type Params = { params: Promise<{ provider: string }> };

export const GET = async (request: NextRequest, { params }: Params) => {
  const { provider } = await params;
  const errorRedirect = (msg: string) =>
    NextResponse.redirect(
      `${APP_URL}/app-connect/${provider}?status=error&message=${encodeURIComponent(msg)}`,
    );

  try {
    const app = getApp(provider);

    if (!app || app.connectionMethod.type !== "oauth") {
      return errorRedirect("Invalid provider");
    }

    const stateParam = request.nextUrl.searchParams.get("state");
    if (!stateParam) {
      return errorRedirect("Missing state parameter");
    }

    const state = verifyOAuthState(stateParam);
    if (!state || state.provider !== provider) {
      return errorRedirect("Invalid state parameter");
    }

    const resolved = await resolveAppCredentials(state.projectId, app);
    if (!resolved) {
      return errorRedirect(`${app.name} is not configured`);
    }

    const redirectUri = `${APP_URL}/api/apps/${provider}/callback`;
    const callbackParams = Object.fromEntries(
      request.nextUrl.searchParams.entries(),
    );

    const result = await app.connectionMethod.exchangeCode({
      appCredentials: resolved.values,
      callbackParams,
      redirectUri,
    });

    const { credentials, scopes, metadata } = result;

    let reconnectId = state.connectionId as string | undefined;

    if (!reconnectId) {
      const identity = extractLabel(metadata)?.toLowerCase().trim();
      if (identity) {
        const existing = await listConnectionsByProvider(
          state.projectId,
          provider,
        );
        const duplicate = existing.find((c) => {
          if (
            !c.metadata ||
            typeof c.metadata !== "object" ||
            Array.isArray(c.metadata)
          )
            return false;
          const existingIdentity = extractLabel(
            c.metadata as Record<string, unknown>,
          );
          return existingIdentity?.toLowerCase().trim() === identity;
        });
        if (duplicate) reconnectId = duplicate.id;
      }
    }

    if (reconnectId) {
      await reconnectConnection(state.projectId, reconnectId, credentials, {
        scopes,
        metadata,
      });
    } else {
      await createConnection(state.projectId, provider, credentials, {
        scopes,
        metadata,
      });
    }

    invalidateGatewayCacheForAccount(state.projectId);

    const successParams = new URLSearchParams({ status: "success" });
    if (state.agentName) {
      successParams.set("agent_name", state.agentName as string);
    }
    return NextResponse.redirect(
      `${APP_URL}/app-connect/${provider}?${successParams}`,
    );
  } catch (err) {
    logger.error({ err, provider }, "OAuth callback failed");
    const message =
      err instanceof Error ? err.message : "An unexpected error occurred";
    return errorRedirect(message);
  }
};
