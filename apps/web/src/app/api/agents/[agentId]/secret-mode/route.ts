import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { updateAgentSecretMode } from "@/lib/services/agent-service";
import { secretModeSchema } from "@/lib/validations/agent";

type Params = { params: Promise<{ agentId: string }> };

export const PATCH = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { agentId } = await params;
    const body = await request.json().catch(() => null);
    const parsed = secretModeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }

    await updateAgentSecretMode(auth.userId, agentId, parsed.data.mode);
    return NextResponse.json({ success: true });
  } catch (err) {
    return handleServiceError(err);
  }
};
