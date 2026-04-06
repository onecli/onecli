import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { invalidateGatewayCache } from "@/lib/gateway-invalidate";
import { getApp } from "@/lib/apps/registry";
import {
  getAppConfig,
  upsertAppConfig,
  deleteAppConfig,
} from "@/lib/services/app-config-service";
import { configBodySchema } from "@/lib/validations/app-config";

type Params = { params: Promise<{ provider: string }> };

export const GET = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { provider } = await params;
    const config = await getAppConfig(auth.accountId, provider);

    return NextResponse.json(
      config ?? { hasCredentials: false, enabled: false },
    );
  } catch (err) {
    return handleServiceError(err);
  }
};

export const POST = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { provider } = await params;

    const body = await request.json().catch(() => null);
    const parsed = configBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }

    const app = getApp(provider);
    if (!app?.configurable) {
      return NextResponse.json(
        { error: `Provider "${provider}" does not support app configuration` },
        { status: 400 },
      );
    }

    const { clientId, clientSecret } = parsed.data;
    await upsertAppConfig(
      auth.accountId,
      provider,
      { clientId, clientSecret },
      app.configurable.fields,
    );

    invalidateGatewayCache(request);

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
};

export const DELETE = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { provider } = await params;
    await deleteAppConfig(auth.accountId, provider);
    invalidateGatewayCache(request);

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return handleServiceError(err);
  }
};
