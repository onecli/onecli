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

    await params; // consume params (required by Next.js)
    const connectionId = request.nextUrl.searchParams.get("connectionId");

    if (!connectionId) {
      return NextResponse.json(
        { error: "connectionId query parameter is required" },
        { status: 400 },
      );
    }

    await deleteConnection(auth.accountId, connectionId);
    invalidateGatewayCache(request);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return handleServiceError(err);
  }
};
