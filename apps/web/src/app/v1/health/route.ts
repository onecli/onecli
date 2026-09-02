import { NextResponse } from "next/server";
import { APP_VERSION } from "@/lib/env";

/**
 * Deploy-compat probe alias of /healthz — the cloud ALB/ECS health checks
 * target this path, and keeping it makes image and infra rollouts
 * order-independent (an old probe config always finds a healthy answer on a
 * new image). NOT part of the API surface: /v1 is served by the api-server.
 */
export const GET = () =>
  NextResponse.json({ status: "ok", version: APP_VERSION });
