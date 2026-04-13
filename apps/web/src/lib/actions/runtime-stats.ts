"use server";

import { db } from "@onecli/db";
import { resolveUserId } from "./resolve-user";

const HOURS_24_MS = 24 * 60 * 60 * 1000;

const getWindowStart = () => new Date(Date.now() - HOURS_24_MS);

export interface RuntimeStats {
  injections24h: number;
  destinations24h: number;
  activeAgents24h: number;
  requests24h: number;
  successRate24h: number;
  avgLatencyMs24h: number;
  p95LatencyMs24h: number;
  lastActivityAt: Date | null;
}

export interface RuntimeActivityItem {
  id: string;
  createdAt: Date;
  host: string;
  path: string;
  method: string;
  agentId: string;
  agentName: string;
  injectionCount: number;
  statusCode: number | null;
  durationMs: number;
  cacheHit: boolean;
  errorCode: string | null;
}

export async function getRuntimeStats(): Promise<RuntimeStats> {
  const userId = await resolveUserId();
  const windowStart = getWindowStart();

  const [aggregate, destinations, activeAgents, durations] = await Promise.all([
    db.runtimeStatBucket.aggregate({
      where: {
        userId,
        bucketGranularity: "hour",
        bucketStart: { gte: windowStart },
      },
      _sum: {
        requestCount: true,
        injectionCount: true,
        errorCount: true,
        totalDurationMs: true,
      },
      _max: {
        lastActivityAt: true,
      },
    }),
    db.runtimeEvent.findMany({
      where: { userId, createdAt: { gte: windowStart } },
      distinct: ["host"],
      select: { host: true },
    }),
    db.runtimeEvent.findMany({
      where: { userId, createdAt: { gte: windowStart } },
      distinct: ["agentId"],
      select: { agentId: true },
    }),
    db.runtimeEvent.findMany({
      where: { userId, createdAt: { gte: windowStart } },
      select: { durationMs: true },
      orderBy: { durationMs: "asc" },
    }),
  ]);

  const requests = aggregate._sum.requestCount ?? 0;
  const injections = aggregate._sum.injectionCount ?? 0;
  const errors = aggregate._sum.errorCount ?? 0;
  const totalDuration = Number(aggregate._sum.totalDurationMs ?? 0);
  const p95Latency = (() => {
    if (durations.length === 0) return 0;
    const p95Index = Math.min(
      durations.length - 1,
      Math.ceil(durations.length * 0.95) - 1,
    );
    return durations[p95Index]?.durationMs ?? 0;
  })();

  return {
    injections24h: injections,
    destinations24h: destinations.length,
    activeAgents24h: activeAgents.length,
    requests24h: requests,
    successRate24h: requests > 0 ? ((requests - errors) / requests) * 100 : 0,
    avgLatencyMs24h: requests > 0 ? totalDuration / requests : 0,
    p95LatencyMs24h: p95Latency,
    lastActivityAt: aggregate._max.lastActivityAt ?? null,
  };
}

export async function getRuntimeActivity(
  limit = 50,
): Promise<RuntimeActivityItem[]> {
  const userId = await resolveUserId();

  const windowStart = getWindowStart();
  const safeLimit = Math.max(1, Math.min(limit, 200));

  const events = await db.runtimeEvent.findMany({
    where: {
      userId,
      createdAt: { gte: windowStart },
    },
    orderBy: { createdAt: "desc" },
    take: safeLimit,
    include: {
      agent: {
        select: {
          name: true,
        },
      },
    },
  });

  return events.map((event) => ({
    id: event.id,
    createdAt: event.createdAt,
    host: event.host,
    path: event.path,
    method: event.method,
    agentId: event.agentId,
    agentName: event.agent.name,
    injectionCount: event.injectionCount,
    statusCode: event.statusCode,
    durationMs: event.durationMs,
    cacheHit: event.cacheHit,
    errorCode: event.errorCode,
  }));
}
