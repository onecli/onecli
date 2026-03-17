import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { getUser, updateProfile } from "@/lib/services/user-service";
import { updateProfileSchema } from "@/lib/validations/user";

export const GET = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const user = await getUser(auth.userId);
    return NextResponse.json(user);
  } catch (err) {
    return handleServiceError(err);
  }
};

export const PATCH = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const body = await request.json().catch(() => null);
    const parsed = updateProfileSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }

    const user = await updateProfile(auth.userId, parsed.data.name);
    return NextResponse.json(user);
  } catch (err) {
    return handleServiceError(err);
  }
};
