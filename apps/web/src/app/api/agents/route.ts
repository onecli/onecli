import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { listAgents, createAgent } from "@/lib/services/agent-service";
import { createAgentSchema } from "@/lib/validations/agent";

export const GET = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const agents = await listAgents(auth.accountId);
    return NextResponse.json(agents);
  } catch (err) {
    return handleServiceError(err);
  }
};

export const POST = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const body = await request.json().catch(() => null);
    const parsed = createAgentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }

    const agent = await createAgent(
      auth.accountId,
      parsed.data.name,
      parsed.data.identifier,
    );
    return NextResponse.json(agent, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
};
