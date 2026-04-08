import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { invalidateGatewayCache } from "@/lib/gateway-invalidate";
import { deleteConnection } from "@/lib/services/connection-service";

type Params = { params: Promise<{ provider: string }> };

export const DELETE = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { provider } = await params;
    await deleteConnection(auth.accountId, provider);
    invalidateGatewayCache(request);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return handleServiceError(err);
  }
};
