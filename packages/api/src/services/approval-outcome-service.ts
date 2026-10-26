import { db } from "@onecli/db";
import { isChannelProviderId } from "@onecli/channels";
import { z } from "zod";
import { AUDIT_ACTIONS } from "./audit-service";
import { ServiceError } from "./errors";
import {
  MAX_OUTCOME_IDS,
  type ApprovalOutcome,
  type ApprovalOutcomeKind,
} from "../validations/approval-outcomes";

/**
 * HOW A GATEWAY APPROVAL ENDED, for the surfaces that only saw it leave the
 * pending list (the web chat polls the gateway, which forgets a decided
 * approval at once). Two records answer it:
 *
 * - the gateway's request-log row (one per held request) says how it ended
 *   (approved, denied, superseded) and, for an approved one, what the
 *   upstream actually did ("0 of 9 created: BillingCountry: …"), so a person
 *   who approved learns the agent's resend is a FIX, not a mystery;
 * - the audit log names where a person decided it (a Slack click names its
 *   presence), so the card reads "Approved in Slack".
 *
 * Fenced twice: the agent must be in the caller's workspace, and both reads
 * are scoped to that workspace AND that agent. Ids in; outcome, place, time,
 * counts and one short upstream error out (the gateway clamps and masks it):
 * never the request's content, never who decided.
 */

/** How far back the records are read: far longer than an approval lives
 * (minutes) plus the time a browser takes to ask about one it saw leave,
 * and short enough that both reads stay on their `(workspace_id,
 * created_at)` index instead of scanning the workspace's whole history. */
const OUTCOME_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** An optional field that drops a malformed value instead of the record. */
const lenient = <T extends z.ZodType>(schema: T) =>
  schema.optional().catch(undefined);
const clamped = (max: number) =>
  lenient(
    z
      .string()
      .min(1)
      .transform((s) => s.slice(0, max)),
  );
const count = lenient(z.number().int().nonnegative());

/** The gateway's `extra_data` on an approval's request-log row. Its
 * `approval_result` (`summary::outcome::RequestResult` plus the card title)
 * is re-validated field by field: the row is ours, but a card renders it. */
const gatewayRow = z.object({
  approval_id: z.string(),
  decision: z.string(),
  approval_reason: lenient(z.string()),
  resolved_at: lenient(z.string()),
  approval_result: lenient(
    z.object({
      ok: z.boolean(),
      succeeded: count,
      total: count,
      error: clamped(200),
      action: clamped(120),
    }),
  ),
});

/** The fields of an approve/deny audit row this read uses. */
const auditRow = z.object({
  approvalId: z.string(),
  presenceId: lenient(z.string()),
  reason: lenient(z.string()),
});

/** The request-log row's decision, as a card's outcome. Expiry and
 * cancellation are left to the browser (it already says "Expired"). */
const kindOf = (
  row: z.infer<typeof gatewayRow>,
): ApprovalOutcomeKind | undefined => {
  if (row.decision === "approval_approved") return "approved";
  if (row.decision !== "approval_denied") return undefined;
  if (row.approval_reason === "superseded") return "replaced";
  return row.approval_reason === "denied" ? "denied" : undefined;
};

export const listApprovalOutcomes = async (input: {
  workspaceId: string;
  organizationId: string;
  agentId: string;
  approvalIds: string[];
}): Promise<ApprovalOutcome[]> => {
  const agent = await db.agent.findFirst({
    where: {
      id: input.agentId,
      workspaceId: input.workspaceId,
      workspace: { organizationId: input.organizationId },
    },
    select: { id: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  const ids = [...new Set(input.approvalIds)].slice(0, MAX_OUTCOME_IDS);
  if (ids.length === 0) return [];
  const since = new Date(Date.now() - OUTCOME_LOOKBACK_MS);

  const [logs, audits] = await Promise.all([
    db.requestLog.findMany({
      where: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        createdAt: { gte: since },
        OR: ids.map((approvalId) => ({
          extraData: { path: ["approval_id"], equals: approvalId },
        })),
      },
      select: { extraData: true, createdAt: true },
    }),
    db.auditLog.findMany({
      where: {
        workspaceId: input.workspaceId,
        createdAt: { gte: since },
        action: { in: [AUDIT_ACTIONS.APPROVE, AUDIT_ACTIONS.DENY] },
        OR: ids.map((approvalId) => ({
          metadata: { path: ["approvalId"], equals: approvalId },
        })),
        AND: [{ metadata: { path: ["agentId"], equals: input.agentId } }],
      },
      orderBy: { createdAt: "asc" },
      select: { action: true, metadata: true, createdAt: true },
    }),
  ]);

  const decisions = audits.flatMap((row) => {
    const meta = auditRow.safeParse(row.metadata);
    return meta.success ? [{ ...row, meta: meta.data }] : [];
  });

  // A Slack decision names its presence; one read resolves them all.
  const presenceIds = [
    ...new Set(decisions.flatMap((d) => d.meta.presenceId ?? [])),
  ];
  const presences = presenceIds.length
    ? await db.agentChannel.findMany({
        where: { id: { in: presenceIds }, agentId: input.agentId },
        select: { id: true, provider: true },
      })
    : [];
  const providerOf = new Map(presences.map((p) => [p.id, p.provider]));

  const outcomes = new Map<string, ApprovalOutcome>();

  // Where and when, from the audit log. First decision wins: the gateway
  // accepts exactly one, and a later row for the same id (an "already
  // settled" click) changes nothing.
  for (const { action, createdAt, meta } of decisions) {
    if (outcomes.has(meta.approvalId)) continue;
    const provider = meta.presenceId
      ? providerOf.get(meta.presenceId)
      : undefined;
    outcomes.set(meta.approvalId, {
      approvalId: meta.approvalId,
      outcome:
        meta.reason === "superseded"
          ? "replaced"
          : action === AUDIT_ACTIONS.APPROVE
            ? "approved"
            : "denied",
      via: provider && isChannelProviderId(provider) ? provider : "web",
      decidedAt: createdAt.toISOString(),
    });
  }

  // How it ended and what it did, from the gateway's row: the authority on
  // the outcome (it covers a dashboard click, which the audit log does not
  // name), and the only record of the upstream's answer.
  for (const log of logs) {
    const parsed = gatewayRow.safeParse(log.extraData);
    if (!parsed.success) continue;
    const row = parsed.data;
    const outcome = kindOf(row);
    if (!outcome) continue;
    const known = outcomes.get(row.approval_id);
    const result = outcome === "approved" ? row.approval_result : undefined;
    outcomes.set(row.approval_id, {
      approvalId: row.approval_id,
      outcome,
      via: known?.via,
      decidedAt:
        known?.decidedAt ?? row.resolved_at ?? log.createdAt.toISOString(),
      ...(result && { result }),
    });
  }
  return [...outcomes.values()];
};
