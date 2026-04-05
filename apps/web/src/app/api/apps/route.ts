import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { invalidateGatewayCache } from "@/lib/gateway-invalidate";
import { getApp } from "@/lib/apps/registry";
import { db } from "@onecli/db";
import { upsertAppConfig } from "@/lib/services/app-config-service";

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

    const body = (await request.json().catch(() => null)) as {
      provider?: string;
      clientId?: string;
      clientSecret?: string;
    } | null;

    if (!body?.provider) {
      return NextResponse.json(
        { error: "provider is required" },
        { status: 400 },
      );
    }

    const app = getApp(body.provider);
    if (!app?.configurable) {
      return NextResponse.json(
        {
          error: `Provider "${body.provider}" does not support app configuration`,
        },
        { status: 400 },
      );
    }

    if (!body.clientId || !body.clientSecret) {
      return NextResponse.json(
        { error: "clientId and clientSecret are required" },
        { status: 400 },
      );
    }

    const result = await upsertAppConfig(
      auth.accountId,
      body.provider,
      { clientId: body.clientId, clientSecret: body.clientSecret },
      app.configurable.fields,
    );

    invalidateGatewayCache(request);

    const config = await db.appConfig.findUnique({
      where: { id: result.id },
      select: { id: true, provider: true, enabled: true, createdAt: true },
    });

    return NextResponse.json(
      {
        id: config!.id,
        provider: config!.provider,
        status: config!.enabled ? "connected" : "disconnected",
        createdAt: config!.createdAt.toISOString(),
      },
      { status: 201 },
    );
  } catch (err) {
    return handleServiceError(err);
  }
};
