import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import {
  updatePolicyRule,
  deletePolicyRule,
} from "@/lib/services/policy-rule-service";
import { updatePolicyRuleSchema } from "@/lib/validations/policy-rule";

type Params = { params: Promise<{ ruleId: string }> };

export const PATCH = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { ruleId } = await params;
    const body = await request.json().catch(() => null);
    const parsed = updatePolicyRuleSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }

    await updatePolicyRule(auth.accountId, ruleId, parsed.data);
    return NextResponse.json({ success: true });
  } catch (err) {
    return handleServiceError(err);
  }
};

export const DELETE = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { ruleId } = await params;
    await deletePolicyRule(auth.accountId, ruleId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return handleServiceError(err);
  }
};
