import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { getGatewayCounts } from "@/lib/services/counts-service";

export const GET = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const counts = await getGatewayCounts(auth.userId);
    return NextResponse.json(counts);
  } catch (err) {
    return handleServiceError(err);
  }
};
