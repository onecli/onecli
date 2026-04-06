import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { getApp } from "@/lib/apps/registry";
import { getAppConfig } from "@/lib/services/app-config-service";
import { db } from "@onecli/db";

const docsBaseURL = "https://onecli.sh/docs/guides/credential-stubs";

type Params = { params: Promise<{ provider: string }> };

export const GET = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { provider } = await params;
    const app = getApp(provider);
    if (!app) {
      return NextResponse.json(
        { error: `Unknown provider: ${provider}` },
        { status: 404 },
      );
    }

    const [config, connection] = await Promise.all([
      getAppConfig(auth.accountId, provider),
      db.appConnection.findUnique({
        where: { accountId_provider: { accountId: auth.accountId, provider } },
        select: {
          status: true,
          scopes: true,
          connectedAt: true,
        },
      }),
    ]);

    const isConfigured =
      (config !== null && config.hasCredentials) || connection !== null;

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:10254";

    const hint = isConfigured
      ? `Your MCP server needs local credential stub files to start. Create them in the format and location the MCP server expects, but use 'onecli-managed' as a placeholder for all secrets. See ${docsBaseURL}/${provider}.md for examples (fallback: ${docsBaseURL}/general-app.md ). The OneCLI gateway handles real OAuth token exchange at request time.`
      : `This app is not configured yet. Go to ${appUrl}/connections?connect=${provider} to set up your credentials.`;

    return NextResponse.json({
      id: app.id,
      name: app.name,
      available: app.available,
      connectionType: app.connectionMethod.type,
      configurable: !!app.configurable,
      config: config
        ? {
            hasCredentials: config.hasCredentials,
            enabled: config.enabled,
          }
        : null,
      connection: connection
        ? {
            status: connection.status,
            scopes: connection.scopes,
            connectedAt: connection.connectedAt,
          }
        : null,
      hint,
    });
  } catch (err) {
    return handleServiceError(err);
  }
};
