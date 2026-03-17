import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { getDefaultAgent } from "@/lib/services/agent-service";

export const GET = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const agent = await getDefaultAgent(auth.userId);
    if (!agent) {
      return NextResponse.json(
        { error: "No default agent found" },
        { status: 404 },
      );
    }

    return NextResponse.json(agent);
  } catch (err) {
    return handleServiceError(err);
  }
};
