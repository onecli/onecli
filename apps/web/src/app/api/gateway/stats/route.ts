import { NextRequest, NextResponse } from "next/server";
import { db } from "@onecli/db";
import { z } from "zod";
import { validateGatewaySecret } from "@/lib/gateway-secret";

const runtimeEventSchema = z.object({
  agent_token: z.string().min(1),
  host: z.string().min(1),
  path: z.string().min(1),
  method: z.string().min(1),
  intercept: z.boolean(),
  injection_count: z.number().int().min(0),
  status_code: z.number().int().min(100).max(599).nullable(),
  duration_ms: z.number().int().min(0),
  cache_hit: z.boolean(),
  error_code: z.string().min(1).nullable(),
});

const floorToHour = (date: Date): Date => {
  const normalized = new Date(date.getTime());
  normalized.setUTCMinutes(0, 0, 0);
  return normalized;
};

export async function POST(request: NextRequest) {
  try {
    if (!validateGatewaySecret(request.headers.get("x-gateway-secret"))) {
      return NextResponse.json(
        { error: "Invalid or missing gateway secret" },
        { status: 403 },
      );
    }

    const parsed = runtimeEventSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const payload = parsed.data;
    const agent = await db.agent.findUnique({
      where: { accessToken: payload.agent_token },
      select: { id: true, userId: true },
    });

    if (!agent) {
      return NextResponse.json({ error: "Invalid agent token" }, { status: 401 });
    }

    const now = new Date();
    const bucketStart = floorToHour(now);
    const hasError =
      payload.error_code !== null ||
      payload.status_code === null ||
      payload.status_code >= 400;

    await db.$transaction(async (tx) => {
      await tx.runtimeEvent.create({
        data: {
          userId: agent.userId,
          agentId: agent.id,
          host: payload.host,
          path: payload.path,
          method: payload.method,
          intercept: payload.intercept,
          injectionCount: payload.injection_count,
          statusCode: payload.status_code,
          durationMs: payload.duration_ms,
          cacheHit: payload.cache_hit,
          errorCode: payload.error_code,
        },
      });

      await tx.runtimeStatBucket.upsert({
        where: {
          userId_bucketStart_bucketGranularity: {
            userId: agent.userId,
            bucketStart,
            bucketGranularity: "hour",
          },
        },
        create: {
          userId: agent.userId,
          bucketStart,
          bucketGranularity: "hour",
          requestCount: 1,
          injectedRequests: payload.injection_count > 0 ? 1 : 0,
          injectionCount: payload.injection_count,
          errorCount: hasError ? 1 : 0,
          cacheHitCount: payload.cache_hit ? 1 : 0,
          totalDurationMs: payload.duration_ms,
          minDurationMs: payload.duration_ms,
          maxDurationMs: payload.duration_ms,
          lastActivityAt: now,
        },
        update: {
          requestCount: { increment: 1 },
          injectedRequests: { increment: payload.injection_count > 0 ? 1 : 0 },
          injectionCount: { increment: payload.injection_count },
          errorCount: { increment: hasError ? 1 : 0 },
          cacheHitCount: { increment: payload.cache_hit ? 1 : 0 },
          totalDurationMs: { increment: payload.duration_ms },
          lastActivityAt: now,
        },
      });

      await tx.$executeRaw`
        UPDATE "RuntimeStatBucket"
        SET
          "minDurationMs" = CASE
            WHEN "minDurationMs" = 0 THEN ${payload.duration_ms}
            ELSE LEAST("minDurationMs", ${payload.duration_ms})
          END,
          "maxDurationMs" = GREATEST("maxDurationMs", ${payload.duration_ms})
        WHERE "userId" = ${agent.userId}
          AND "bucketStart" = ${bucketStart}
          AND "bucketGranularity" = 'hour'
      `;
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
