import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import {
  getAgentSecrets,
  updateAgentSecrets,
} from "@/lib/services/agent-service";
import { updateAgentSecretsSchema } from "@/lib/validations/agent";

type Params = { params: Promise<{ agentId: string }> };

export const GET = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { agentId } = await params;
    const secretIds = await getAgentSecrets(auth.userId, agentId);
    return NextResponse.json(secretIds);
  } catch (err) {
    return handleServiceError(err);
  }
};

export const PUT = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { agentId } = await params;
    const body = await request.json().catch(() => null);
    const parsed = updateAgentSecretsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }

    await updateAgentSecrets(auth.userId, agentId, parsed.data.secretIds);
    return NextResponse.json({ success: true });
  } catch (err) {
    return handleServiceError(err);
  }
};
