"use server";

import { db } from "@onecli/db";
import { Prisma, type AuditLog } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import type {
  AuditFilters,
  DateRangeKey,
} from "@/app/(dashboard)/audit/_components/audit-filters";

const PAGE_SIZE = 20;

const RANGE_MS: Record<Exclude<DateRangeKey, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

async function resolveUserId(authId?: string): Promise<string | null> {
  if (!authId) {
    const session = await getServerSession();
    if (!session) return null;
    authId = session.id;
  }

  const user = await db.user.findUnique({
    where: { cognitoId: authId },
    select: { id: true },
  });

  return user?.id ?? null;
}

// ---------------------------------------------------------------------------
// Prisma-based filter builder (used when there's NO text search)
// ---------------------------------------------------------------------------

function buildFilterWhere(
  userId: string,
  filters?: AuditFilters,
): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = { userId };

  if (filters?.services?.length) {
    where.service = { in: filters.services };
  }
  if (filters?.statuses?.length) {
    where.status = { in: filters.statuses };
  }
  if (filters?.sources?.length) {
    where.source = { in: filters.sources };
  }
  if (filters?.range && filters.range !== "all") {
    const ms = RANGE_MS[filters.range];
    where.createdAt = { gte: new Date(Date.now() - ms) };
  }

  return where;
}

// ---------------------------------------------------------------------------
// Raw-SQL filter builder (used when there IS a text search)
//
// Prisma's `string_contains` on a Json field only works when the stored value
// is a plain string — it does NOT search inside JSON objects/arrays.
// We fall back to raw SQL so we can cast `metadata::text ILIKE '%…%'` which
// searches across all keys and values in the serialised JSON.
// ---------------------------------------------------------------------------

type AuditLogRow = Pick<
  AuditLog,
  "id" | "action" | "service" | "status" | "source" | "metadata" | "createdAt"
>;

function buildRawConditions(userId: string, filters: AuditFilters) {
  const conditions: Prisma.Sql[] = [Prisma.sql`"userId" = ${userId}`];

  if (filters.q) {
    // Escape ILIKE wildcards so user input is treated as a literal string
    const escaped = filters.q.replace(/[%_\\]/g, "\\$&");
    const pattern = `%${escaped}%`;
    conditions.push(
      Prisma.sql`("action" ILIKE ${pattern} OR "metadata"::text ILIKE ${pattern})`,
    );
  }

  if (filters.services?.length) {
    conditions.push(Prisma.sql`"service" = ANY(${filters.services})`);
  }
  if (filters.statuses?.length) {
    conditions.push(Prisma.sql`"status" = ANY(${filters.statuses})`);
  }
  if (filters.sources?.length) {
    conditions.push(Prisma.sql`"source" = ANY(${filters.sources})`);
  }
  if (filters.range && filters.range !== "all") {
    const ms = RANGE_MS[filters.range];
    conditions.push(Prisma.sql`"createdAt" >= ${new Date(Date.now() - ms)}`);
  }

  return Prisma.join(conditions, " AND ");
}

async function searchAuditLogs(
  userId: string,
  page: number,
  filters: AuditFilters,
) {
  const where = buildRawConditions(userId, filters);
  const offset = (page - 1) * PAGE_SIZE;

  const [logs, countResult] = await Promise.all([
    db.$queryRaw<AuditLogRow[]>`
      SELECT "id", "action", "service", "status", "source", "metadata", "createdAt"
      FROM "AuditLog"
      WHERE ${where}
      ORDER BY "createdAt" DESC
      LIMIT ${PAGE_SIZE}
      OFFSET ${offset}
    `,
    db.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count
      FROM "AuditLog"
      WHERE ${where}
    `,
  ]);

  const total = Number(countResult[0].count);

  return {
    logs,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getDistinctServices(authId?: string) {
  const userId = await resolveUserId(authId);
  if (!userId) return [];

  const groups = await db.auditLog.groupBy({
    by: ["service"],
    where: { userId },
  });

  return groups.map((g) => g.service);
}

export async function getAuditLogs(
  page = 1,
  authId?: string,
  filters?: AuditFilters,
) {
  const userId = await resolveUserId(authId);
  if (!userId) throw new Error("Not authenticated");

  // When there's a text search, use raw SQL so we can search inside metadata
  if (filters?.q) {
    return searchAuditLogs(userId, page, filters);
  }

  const where = buildFilterWhere(userId, filters);

  const [logs, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        action: true,
        service: true,
        status: true,
        source: true,
        metadata: true,
        createdAt: true,
      },
    }),
    db.auditLog.count({ where }),
  ]);

  return {
    logs,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
  };
}

export async function getRecentAuditLogs(limit = 5, authId?: string) {
  const userId = await resolveUserId(authId);
  if (!userId) return [];

  return db.auditLog.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      action: true,
      service: true,
      status: true,
      source: true,
      createdAt: true,
    },
  });
}

export async function getAuditStats(authId?: string) {
  const userId = await resolveUserId(authId);
  if (!userId) return null;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [totalActions, recentActions, serviceCount] = await Promise.all([
    db.auditLog.count({ where: { userId } }),
    db.auditLog.count({
      where: { userId, createdAt: { gte: thirtyDaysAgo } },
    }),
    db.auditLog
      .groupBy({
        by: ["service"],
        where: { userId },
      })
      .then((groups) => groups.length),
  ]);

  return {
    totalActions,
    recentActions,
    serviceCount,
  };
}

export async function getProxyCounts(authId?: string) {
  const userId = await resolveUserId(authId);
  if (!userId) return { agents: 0, secrets: 0, policies: 0 };

  const [agents, secrets, policies] = await Promise.all([
    db.agent.count({ where: { userId } }),
    db.secret.count({ where: { userId } }),
    db.policy.count({ where: { userId } }),
  ]);

  return { agents, secrets, policies };
}
