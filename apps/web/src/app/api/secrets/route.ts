import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { listSecrets, createSecret } from "@/lib/services/secret-service";
import { createSecretSchema } from "@/lib/validations/secret";

export const GET = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const secrets = await listSecrets(auth.userId);
    return NextResponse.json(secrets);
  } catch (err) {
    return handleServiceError(err);
  }
};

export const POST = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const body = await request.json().catch(() => null);
    const parsed = createSecretSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }

    const secret = await createSecret(auth.userId, parsed.data);
    return NextResponse.json(secret, { status: 201 });
  } catch (err) {
    return handleServiceError(err);
  }
};
