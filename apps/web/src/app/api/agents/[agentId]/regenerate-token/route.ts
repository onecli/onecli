import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { regenerateAgentToken } from "@/lib/services/agent-service";

type Params = { params: Promise<{ agentId: string }> };

export const POST = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { agentId } = await params;
    const result = await regenerateAgentToken(auth.userId, agentId);
    return NextResponse.json(result);
  } catch (err) {
    return handleServiceError(err);
  }
};
