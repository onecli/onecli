import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { invalidateGatewayCache } from "@/lib/gateway-invalidate";
import { getApp } from "@/lib/apps/registry";
import { upsertConnection } from "@/lib/services/connection-service";

type Params = { params: Promise<{ provider: string }> };

/**
 * POST /api/apps/{provider}/connect
 *
 * Submit API key credentials for an api_key type connection.
 * Stores the first field value as `access_token` so the gateway picks it up.
 */
export const POST = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { provider } = await params;
    const app = getApp(provider);

    if (!app || !app.available || app.connectionMethod.type !== "api_key") {
      return NextResponse.json(
        {
          error: `Provider "${provider}" does not support API key connections`,
        },
        { status: 400 },
      );
    }

    const body = (await request.json()) as { fields?: Record<string, string> };
    if (!body.fields) {
      return NextResponse.json(
        { error: "Missing fields in request body" },
        { status: 400 },
      );
    }

    for (const field of app.connectionMethod.fields) {
      if (!body.fields[field.name]?.trim()) {
        return NextResponse.json(
          { error: `${field.label} is required` },
          { status: 400 },
        );
      }
    }

    const primaryField = app.connectionMethod.fields[0];
    const credentials: Record<string, unknown> = {
      access_token: body.fields[primaryField!.name],
    };

    await upsertConnection(auth.accountId, provider, credentials);
    invalidateGatewayCache(request);

    return NextResponse.json({ success: true });
  } catch (err) {
    return handleServiceError(err);
  }
};
