import { db, Prisma } from "@onecli/db";

export interface RequestLogEntry {
  id: string;
  agentId: string;
  agentName: string | null;
  method: string;
  host: string;
  path: string;
  provider: string;
  status: number;
  latencyMs: number;
  injectionCount: number;
  extraData: unknown;
  /** Display name of the user who approved/denied this request, if resolved. */
  approvedBy: string | null;
  createdAt: string;
}

const DECISION_BLOCKED = "blocked";
const DECISION_RATE_LIMITED = "rate_limited";
const BLOCKED_BY_RULE_KEY = "blocked_by_rule";

export const isBlockedRequest = (log: RequestLogEntry): boolean => {
  const data = log.extraData as Record<string, unknown> | null;
  return data?.decision === DECISION_BLOCKED;
};

export const isRateLimitedRequest = (log: RequestLogEntry): boolean => {
  const data = log.extraData as Record<string, unknown> | null;
  return data?.decision === DECISION_RATE_LIMITED;
};

export const isOwnKey = (log: RequestLogEntry): boolean => {
  if (log.injectionCount !== 0) return false;
  const data = log.extraData as Record<string, unknown> | null;
  return !data?.decision;
};

export const isDefaultDenied = (log: RequestLogEntry): boolean => {
  const data = log.extraData as Record<string, unknown> | null;
  return data?.decision === "blocked_by_default_policy";
};

export const getBlockedByRule = (log: RequestLogEntry): string | null => {
  const data = log.extraData as Record<string, unknown> | null;
  if (typeof data?.[BLOCKED_BY_RULE_KEY] === "string") {
    return data[BLOCKED_BY_RULE_KEY];
  }
  return null;
};

export type ApprovalDecision =
  | "pending"
  | "approved"
  | "denied"
  | "timed_out"
  | "cancelled";

export const getApprovalDecision = (
  log: RequestLogEntry,
): ApprovalDecision | null => {
  const data = log.extraData as Record<string, unknown> | null;
  const decision = data?.decision;
  if (decision === "approval_pending") return "pending";
  if (decision === "approval_approved") return "approved";
  if (decision === "approval_denied") {
    return data?.approval_reason === "timed out" ? "timed_out" : "denied";
  }
  if (decision === "approval_cancelled") return "cancelled";
  return null;
};

export const isApprovalPending = (log: RequestLogEntry): boolean => {
  const data = log.extraData as Record<string, unknown> | null;
  return data?.decision === "approval_pending";
};

export const isApprovalDenied = (log: RequestLogEntry): boolean => {
  const data = log.extraData as Record<string, unknown> | null;
  return data?.decision === "approval_denied";
};

export const isApprovalApproved = (log: RequestLogEntry): boolean => {
  const data = log.extraData as Record<string, unknown> | null;
  return data?.decision === "approval_approved";
};

export const getApprovalReason = (log: RequestLogEntry): string | null => {
  const data = log.extraData as Record<string, unknown> | null;
  const reason = data?.approval_reason;
  return typeof reason === "string" ? reason : null;
};

/** The gateway-assigned approval id linking a request log to its held approval. */
export const getApprovalId = (log: RequestLogEntry): string | null => {
  const data = log.extraData as Record<string, unknown> | null;
  const id = data?.approval_id;
  return typeof id === "string" ? id : null;
};

/** The user id the gateway stamped on a resolved approval (`approved_by`). */
const approvedByUserId = (extraData: unknown): string | null => {
  const data = extraData as Record<string, unknown> | null;
  const by = data?.approved_by;
  return typeof by === "string" ? by : null;
};

export const getConnectionLabel = (log: RequestLogEntry): string | null => {
  const data = log.extraData as Record<string, unknown> | null;
  const label = data?.connection_label;
  return typeof label === "string" ? label : null;
};

export interface RequestLogPage {
  logs: RequestLogEntry[];
  nextCursor: { createdAt: string; id: string } | null;
}

export interface ActivityPageParams {
  cursor?: { createdAt: string; id: string };
  limit?: number;
  statusFilter?: "all" | "errors";
}

const resolveAgentNames = async (
  projectId: string,
  agentIds: string[],
): Promise<Map<string, string>> => {
  if (agentIds.length === 0) return new Map();
  const agents = await db.agent.findMany({
    where: { id: { in: agentIds }, projectId },
    select: { id: true, name: true },
  });
  return new Map(agents.map((a) => [a.id, a.name]));
};

/** Resolve approver user ids → a display name (name, falling back to email). */
const resolveUserNames = async (
  userIds: string[],
): Promise<Map<string, string>> => {
  if (userIds.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true },
  });
  return new Map(users.map((u) => [u.id, u.name ?? u.email]));
};

const collectApproverIds = (rows: { extraData: unknown }[]): string[] => [
  ...new Set(
    rows
      .map((r) => approvedByUserId(r.extraData))
      .filter((id): id is string => id !== null),
  ),
];

type RequestLogRow = Prisma.RequestLogGetPayload<object>;

const toEntry = (
  log: RequestLogRow,
  agentMap: Map<string, string>,
  userMap: Map<string, string>,
): RequestLogEntry => {
  const approverId = approvedByUserId(log.extraData);
  return {
    id: log.id,
    agentId: log.agentId,
    agentName: agentMap.get(log.agentId) ?? null,
    method: log.method,
    host: log.host,
    path: log.path,
    provider: log.provider,
    status: log.status,
    latencyMs: log.latencyMs,
    injectionCount: log.injectionCount,
    extraData: log.extraData,
    approvedBy: approverId ? (userMap.get(approverId) ?? null) : null,
    createdAt: log.createdAt.toISOString(),
  };
};

export const getRecentRequestLogs = async (
  projectId: string,
  limit = 5,
): Promise<RequestLogEntry[]> => {
  const logs = await db.requestLog.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const agentIds = [...new Set(logs.map((l) => l.agentId))];
  const [agentMap, userMap] = await Promise.all([
    resolveAgentNames(projectId, agentIds),
    resolveUserNames(collectApproverIds(logs)),
  ]);

  return logs.map((l) => toEntry(l, agentMap, userMap));
};

export const getRequestLogs = async (
  projectId: string,
  params: ActivityPageParams = {},
): Promise<RequestLogPage> => {
  const limit = Math.min(params.limit ?? 50, 200);
  const { cursor, statusFilter } = params;

  const where: Prisma.RequestLogWhereInput = { projectId };

  if (statusFilter === "errors") {
    where.status = { gte: 400 };
  }

  if (cursor) {
    where.OR = [
      { createdAt: { lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
    ];
  }

  const logs = await db.requestLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = logs.length > limit;
  const page = hasMore ? logs.slice(0, limit) : logs;

  const agentIds = [...new Set(page.map((l) => l.agentId))];
  const [agentMap, userMap] = await Promise.all([
    resolveAgentNames(projectId, agentIds),
    resolveUserNames(collectApproverIds(page)),
  ]);

  const lastLog = page[page.length - 1];
  const nextCursor =
    hasMore && lastLog
      ? { createdAt: lastLog.createdAt.toISOString(), id: lastLog.id }
      : null;

  return {
    logs: page.map((l) => toEntry(l, agentMap, userMap)),
    nextCursor,
  };
};
