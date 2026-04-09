import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { unauthorized } from "@/lib/api-utils";
import { API_URL } from "@/lib/env";

/**
 * GET /api/gateway-url
 *
 * Returns the gateway base URL for SDK consumers.
 * The SDK calls this once to discover where to poll for manual approvals.
 *
 * Auth: `Authorization: Bearer oc_...` (user API key) or JWT session.
 */
export async function GET(request: NextRequest) {
  const auth = await resolveApiAuth(request);
  if (!auth) return unauthorized();

  return NextResponse.json({ url: API_URL });
}
