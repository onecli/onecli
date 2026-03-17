import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { getApiKey } from "@/lib/services/api-key-service";

export const GET = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const result = await getApiKey(auth.userId);
    return NextResponse.json(result);
  } catch (err) {
    return handleServiceError(err);
  }
};
