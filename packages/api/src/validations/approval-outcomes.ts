/**
 * The approval-outcomes wire (`GET /v1/agents/:agentId/approval-outcomes`):
 * shared by the API and the web client, so the two sides cannot drift.
 */

export type ApprovalOutcomeKind = "approved" | "denied" | "replaced";

/** What an approved request actually did, from the upstream's answer (the
 * gateway's `summary::outcome::RequestResult`). Absent for a plain success. */
export interface ApprovalResult {
  /** Every part of the request succeeded. */
  ok: boolean;
  /** For a request over many records: how many succeeded, of how many. */
  succeeded?: number;
  total?: number;
  /** The upstream's first error, short and masked. */
  error?: string;
  /** The held request's card title ("Create 9 Accounts"): the verb its
   * result reads in ("Created 0 of 9"). */
  action?: string;
}

export interface ApprovalOutcome {
  approvalId: string;
  outcome: ApprovalOutcomeKind;
  /** Where a person decided it: a channel provider id (`slack`) or `web`.
   * Absent when only the gateway's record names it (a dashboard click). */
  via?: string;
  /** ISO time of the decision. */
  decidedAt: string;
  /** What the approved request did upstream, when there is more to say than
   * "it ran". */
  result?: ApprovalResult;
}

/** The most ids one read answers: a chat only asks about cards it saw
 * leave, a handful at a time. */
export const MAX_OUTCOME_IDS = 50;
