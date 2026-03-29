import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { listConnections } from "@/lib/services/connection-service";

export const GET = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const connections = await listConnections(auth.accountId);
    return NextResponse.json(connections);
  } catch (err) {
    return handleServiceError(err);
  }
};
