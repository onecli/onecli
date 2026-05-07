import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { unauthorized } from "@/lib/api-utils";
import { GATEWAY_SKILL } from "@/lib/skills/gateway-skill";

export const GET = async (request: NextRequest) => {
  const auth = await resolveApiAuth(request);
  if (!auth) return unauthorized();

  return new NextResponse(GATEWAY_SKILL, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
