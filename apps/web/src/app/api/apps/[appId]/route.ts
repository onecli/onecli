import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { invalidateGatewayCache } from "@/lib/gateway-invalidate";
import { db } from "@onecli/db";
import { deleteAppConfig } from "@/lib/services/app-config-service";

type Params = { params: Promise<{ appId: string }> };

export const DELETE = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { appId } = await params;

    // Resolve the provider from the app config ID
    const config = await db.appConfig.findFirst({
      where: { id: appId, accountId: auth.accountId },
      select: { provider: true },
    });

    if (!config) {
      return NextResponse.json(
        { error: "App config not found" },
        { status: 404 },
      );
    }

    await deleteAppConfig(auth.accountId, config.provider);
    invalidateGatewayCache(request);

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return handleServiceError(err);
  }
};
