import { NextResponse } from "next/server";
import { APP_VERSION } from "@/lib/env";

/**
 * Web-host liveness + build-version probe (the ALB health check target, and
 * the deploy-skew diagnostic the in-process /v1/health used to provide).
 * The API's own health lives at the api-server's /v1/health.
 */
export const GET = () =>
  NextResponse.json({ status: "ok", version: APP_VERSION });
