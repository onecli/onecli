import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { updateSecret, deleteSecret } from "@/lib/services/secret-service";
import { updateSecretSchema } from "@/lib/validations/secret";

type Params = { params: Promise<{ secretId: string }> };

export const PATCH = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { secretId } = await params;
    const body = await request.json().catch(() => null);
    const parsed = updateSecretSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }

    await updateSecret(auth.userId, secretId, parsed.data);
    return NextResponse.json({ success: true });
  } catch (err) {
    return handleServiceError(err);
  }
};

export const DELETE = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { secretId } = await params;
    await deleteSecret(auth.userId, secretId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return handleServiceError(err);
  }
};
