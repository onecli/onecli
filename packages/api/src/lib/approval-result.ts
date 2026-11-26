import type { ApprovalResult } from "../validations/approval-outcomes";

/**
 * One line saying what an approved request actually did, the same words on
 * every surface (the web card, the Slack card): "Created 0 of 9 ·
 * BillingCountry: …". The verb comes from the request's card title
 * ("Create 9 Accounts"), which the gateway records with the result; a title
 * with no known verb reads "0 of 9 succeeded". `undefined` when there is
 * nothing worth adding to "Approved" (a plain success).
 */
export const approvalResultLine = (
  result: ApprovalResult | undefined,
):
  | {
      /** The whole line. */
      text: string;
      /** Its first part alone ("Created 0 of 9"), for a narrow badge. */
      short: string;
      failed: boolean;
    }
  | undefined => {
  if (!result) return undefined;
  const counted =
    result.total !== undefined && result.succeeded !== undefined
      ? countLine(result.action, result.succeeded, result.total)
      : undefined;
  if (result.ok) {
    return counted
      ? { text: counted, short: counted, failed: false }
      : undefined;
  }
  const short = counted ?? "It failed";
  return {
    text: result.error ? `${short} · ${result.error}` : short,
    short,
    failed: true,
  };
};

/** The gateway's title verbs (`summary::salesforce`), in the past tense. */
const PAST: Record<string, string> = {
  create: "Created",
  update: "Updated",
  upsert: "Upserted",
  delete: "Deleted",
};

/** "Create 9 Accounts" → "Created 0 of 9"; no known verb → "0 of 9
 * succeeded". */
const countLine = (
  action: string | undefined,
  succeeded: number,
  total: number,
): string => {
  const verb = PAST[(action ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? ""];
  return verb
    ? `${verb} ${String(succeeded)} of ${String(total)}`
    : `${String(succeeded)} of ${String(total)} succeeded`;
};
