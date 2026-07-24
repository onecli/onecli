import { db, Prisma } from "@onecli/db";

import { LLM_HOST_FRAGMENTS } from "../lib/llm-hosts";
import { getRoleResolver } from "../providers";

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
  /** The generation-stable logicalId of the v2 rule that decided this request
   * (step 9) — the future filter/link key; the display name rides
   * `extra_data.matched_rule_name` (see {@link getMatchedRuleName}). */
  matchedRuleLogicalId: string | null;
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

/** The display name of the v2 policy rule that decided this request (step 9
 * visibility) — a snapshot that survives rule deletion. Null pre-v2, for
 * legacy decisions, for plain allows, and for ORG rules redacted from a
 * non-admin viewer (the scope then still reads "organization" — see
 * {@link getMatchedRuleScope}). The typed `matched_rule_logical_id` column
 * rides the row itself. */
export const getMatchedRuleName = (log: RequestLogEntry): string | null => {
  const data = log.extraData as Record<string, unknown> | null;
  const name = data?.matched_rule_name;
  return typeof name === "string" ? name : null;
};

/** The deciding rule's level ("organization" | "project"), recorded beside the
 * name. Survives redaction, so the UI can still say "decided by an
 * organization rule" without the name. */
export const getMatchedRuleScope = (log: RequestLogEntry): string | null => {
  const data = log.extraData as Record<string, unknown> | null;
  const scope = data?.matched_rule_scope;
  return typeof scope === "string" ? scope : null;
};

/** Who is reading the logs — drives the org-rule redaction below. */
export interface RequestLogViewer {
  userId: string;
  organizationId: string;
}

/** Org-rule details are org-admin-only.
 * A null resolver/role — OSS, or an unknown membership — fails SAFE to
 * non-admin; OSS rows never carry org-scoped matched rules anyway. */
const viewerSeesOrgRules = async (
  viewer: RequestLogViewer | undefined,
): Promise<boolean> => {
  if (!viewer) return false;
  const role = await getRoleResolver()?.getUserRole(
    viewer.userId,
    viewer.organizationId,
  );
  return role === "admin" || role === "owner";
};

/** Strip an ORG-decided rule's identifying details for a non-admin viewer:
 * the display name leaves `extra_data` (this object IS the raw payload the
 * client receives, including the detail dialog's raw dump) and the logical id
 * leaves the row DTO; `matched_rule_scope` stays so the UI can render
 * "decided by an organization rule". A v2 BLOCK/RATE decision carries the SAME
 * org rule's name in `blocked_by_rule` too — scrubbed with it (Activity is a
 * browsable bulk surface, held to the stricter admin-only visibility even
 * though the one-shot live 403/429 names the rule to the caller). Legacy
 * (old-model) rows carry no `matched_rule_scope`, so their `blocked_by_rule`
 * — always project-level — is untouched, as are project-scoped attributions. */
const redactOrgMatchedRule = (entry: RequestLogEntry): RequestLogEntry => {
  if (getMatchedRuleScope(entry) !== "organization") return entry;
  const data = { ...(entry.extraData as Record<string, unknown>) };
  delete data.matched_rule_name;
  delete data[BLOCKED_BY_RULE_KEY];
  return { ...entry, extraData: data, matchedRuleLogicalId: null };
};

export interface RequestLogPage {
  logs: RequestLogEntry[];
  nextCursor: { createdAt: string; id: string } | null;
}

export type ActivityFilter = "all" | "hide-llm" | "blocked";

export interface ActivityPageParams {
  cursor?: { createdAt: string; id: string };
  limit?: number;
  filter?: ActivityFilter;
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
    matchedRuleLogicalId: log.matchedRuleLogicalId,
    approvedBy: approverId ? (userMap.get(approverId) ?? null) : null,
    createdAt: log.createdAt.toISOString(),
  };
};

export const getRecentRequestLogs = async (
  projectId: string,
  limit = 5,
  viewer?: RequestLogViewer,
): Promise<RequestLogEntry[]> => {
  const logs = await db.requestLog.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const agentIds = [...new Set(logs.map((l) => l.agentId))];
  const [agentMap, userMap, seesOrgRules] = await Promise.all([
    resolveAgentNames(projectId, agentIds),
    resolveUserNames(collectApproverIds(logs)),
    viewerSeesOrgRules(viewer),
  ]);

  const entries = logs.map((l) => toEntry(l, agentMap, userMap));
  return seesOrgRules ? entries : entries.map(redactOrgMatchedRule);
};

/**
 * Build the Prisma `where` for an activity query: project scope, the selected
 * {@link ActivityFilter}, and the keyset-pagination cursor. Pure and synchronous
 * so it can be unit-tested without a database.
 */
export const buildActivityWhere = (
  projectId: string,
  params: Pick<ActivityPageParams, "cursor" | "filter"> = {},
): Prisma.RequestLogWhereInput => {
  const { cursor, filter = "all" } = params;
  const where: Prisma.RequestLogWhereInput = { projectId };

  if (filter === "blocked") {
    where.status = { gte: 400 };
  } else if (filter === "hide-llm") {
    // Exclude AI-provider traffic: keep rows whose host contains none of the
    // known LLM host fragments (mirrors the gateway's is_llm_host).
    where.NOT = {
      OR: LLM_HOST_FRAGMENTS.map(
        (fragment): Prisma.RequestLogWhereInput => ({
          host: { contains: fragment, mode: "insensitive" },
        }),
      ),
    };
  }

  if (cursor) {
    where.OR = [
      { createdAt: { lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
    ];
  }

  return where;
};

export const getRequestLogs = async (
  projectId: string,
  params: ActivityPageParams = {},
  viewer?: RequestLogViewer,
): Promise<RequestLogPage> => {
  const limit = Math.min(params.limit ?? 50, 200);
  const where = buildActivityWhere(projectId, params);

  const logs = await db.requestLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = logs.length > limit;
  const page = hasMore ? logs.slice(0, limit) : logs;

  const agentIds = [...new Set(page.map((l) => l.agentId))];
  const [agentMap, userMap, seesOrgRules] = await Promise.all([
    resolveAgentNames(projectId, agentIds),
    resolveUserNames(collectApproverIds(page)),
    viewerSeesOrgRules(viewer),
  ]);

  const lastLog = page[page.length - 1];
  const nextCursor =
    hasMore && lastLog
      ? { createdAt: lastLog.createdAt.toISOString(), id: lastLog.id }
      : null;

  const entries = page.map((l) => toEntry(l, agentMap, userMap));
  return {
    logs: seesOrgRules ? entries : entries.map(redactOrgMatchedRule),
    nextCursor,
  };
};
