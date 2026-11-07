import {
  MAX_OUTCOME_IDS,
  type ApprovalOutcome,
  type ApprovalResult,
} from "@onecli/api/validations/approval-outcomes";
import { apiGet } from "./client";

/**
 * How an agent's gateway approvals ended (outcome, where, when, and for an
 * approved request what it actually did), for the chat cards that only saw
 * them leave the pending list:
 * GET /v1/agents/:agentId/approval-outcomes?ids=…
 */

export { MAX_OUTCOME_IDS };
export type { ApprovalOutcome, ApprovalResult };

export const list = (agentId: string, approvalIds: readonly string[]) =>
  apiGet<{ outcomes: ApprovalOutcome[] }>(
    `/v1/agents/${encodeURIComponent(agentId)}/approval-outcomes?ids=${approvalIds
      .map(encodeURIComponent)
      .join(",")}`,
  ).then((r) => r.outcomes);
