import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { invalidateGatewayCache } from "@/lib/gateway-invalidate";
import { getApp } from "@/lib/apps/registry";
import { db } from "@onecli/db";
import { upsertAppConfig } from "@/lib/services/app-config-service";
import { connectAppSchema } from "@/lib/validations/app-config";

export const GET = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const configs = await db.appConfig.findMany({
      where: { accountId: auth.accountId, enabled: true },
      select: { id: true, provider: true, enabled: true, createdAt: true },
    });

    return NextResponse.json(
      configs.map((c) => ({
        id: c.id,
        provider: c.provider,
        status: c.enabled ? "connected" : "disconnected",
        createdAt: c.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    return handleServiceError(err);
  }
};

export const POST = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const body = await request.json().catch(() => null);
    const parsed = connectAppSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }

    const { provider, clientId, clientSecret } = parsed.data;

    const app = getApp(provider);
    if (!app?.configurable) {
      return NextResponse.json(
        { error: `Provider "${provider}" does not support app configuration` },
        { status: 400 },
      );
    }

    const result = await upsertAppConfig(
      auth.accountId,
      provider,
      { clientId, clientSecret },
      app.configurable.fields,
    );

    invalidateGatewayCache(request);

    return NextResponse.json(
      {
        id: result.id,
        provider: result.provider,
        status: "connected",
        createdAt: new Date().toISOString(),
      },
      { status: 201 },
    );
  } catch (err) {
    return handleServiceError(err);
  }
};
