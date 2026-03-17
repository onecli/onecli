import { NextResponse } from "next/server";
import { ServiceError, type ServiceErrorCode } from "@/lib/services/errors";

const STATUS_MAP: Record<ServiceErrorCode, number> = {
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  CONFLICT: 409,
  FORBIDDEN: 403,
};

export const handleServiceError = (err: unknown): NextResponse => {
  if (err instanceof ServiceError) {
    return NextResponse.json(
      { error: err.message },
      { status: STATUS_MAP[err.code] },
    );
  }
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
};

export const unauthorized = () =>
  NextResponse.json({ error: "Unauthorized" }, { status: 401 });
