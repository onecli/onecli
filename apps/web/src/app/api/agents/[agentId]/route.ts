import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { renameAgent, deleteAgent } from "@/lib/services/agent-service";
import { renameAgentSchema } from "@/lib/validations/agent";

type Params = { params: Promise<{ agentId: string }> };

export const PATCH = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { agentId } = await params;
    const body = await request.json().catch(() => null);
    const parsed = renameAgentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }

    await renameAgent(auth.userId, agentId, parsed.data.name);
    return NextResponse.json({ success: true });
  } catch (err) {
    return handleServiceError(err);
  }
};

export const DELETE = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { agentId } = await params;
    await deleteAgent(auth.userId, agentId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return handleServiceError(err);
  }
};
