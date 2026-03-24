import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import {
  listPolicyRules,
  createPolicyRule,
} from "@/lib/services/policy-rule-service";
import { createPolicyRuleSchema } from "@/lib/validations/policy-rule";

export const GET = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const rules = await listPolicyRules(auth.accountId);
    return NextResponse.json(rules);
  } catch (err) {
    return handleServiceError(err);
  }
};

export const POST = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const body = await request.json().catch(() => null);
    const parsed = createPolicyRuleSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }

    const rule = await createPolicyRule(auth.accountId, parsed.data);
    return NextResponse.json(rule, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
};
