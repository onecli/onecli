import type { GatewayPendingApproval } from "../channels/gateway-approvals";
import { defineJudge } from "./judge";

/**
 * THE SUPERSEDE JUDGE: a person wrote while the agent waits on a held
 * request. Does the message change what that request will do?
 *
 * - CHANGE or CANCEL -> `replace`: the caller withdraws the held request so
 *   the agent can send the revision;
 * - ALREADY, NEW or OTHER (and every failure) -> `keep`: the card stays. A
 *   wrong keep costs the person one Deny click; a wrong replace costs a
 *   re-ask, so unsure means keep.
 *
 * NEW exists because a person often asks for a second, separate task while
 * the first waits ("change the owner" while employees=100 is held); that
 * must not withdraw the first.
 *
 * ALREADY exists because the judge must compare against the request's
 * VALUES: "I want 3 of them in Boston" while 3 already are reads as a
 * correction but changes nothing, and withdrawing a correct request then is
 * the worst outcome (a live session lost ~9 attempts to it). The
 * one line of reasoning (`reason: true`) is what lets a fast model make that
 * comparison: 33/39 -> 36/39 on the eval.
 *
 * Tuned against `supersede-judge.eval.test.ts`: change the wording only
 * with a fresh eval run.
 */

/** The whole judge, model call included, well inside a chat send. */
export const SUPERSEDE_DEADLINE_MS = 3_000;
/** How much of one held request the judge reads. */
const REQUEST_CLAMP = 4_000;
const MESSAGE_CLAMP = 600;
/** Records whose values the judge sees (the card's table rows). */
const ROWS_SHOWN = 12;

export type SupersedeVerdict = "replace" | "keep";

export interface SupersedeInput {
  agentName: string;
  /** The agent's held requests, as the gateway reports them. */
  held: readonly GatewayPendingApproval[];
  /** What the person just wrote. */
  message: string;
}

/**
 * One held request as the judge reads it, WITH its values, so a message
 * that agrees with the request is recognizably not a change.
 *
 * A list of records is described record by record, each with what it sets
 * AND what it leaves alone. The card's own detail lines are left out then:
 * they summarize across records ("Industry -> Surfing · 1 record"), and
 * the judge read such a line as true of every record ("add Surfing to
 * Pinecrest" was judged ALREADY because ANOTHER record got it).
 */
export const describeHeldRequest = (a: GatewayPendingApproval): string => {
  const summary = a.summary;
  if (!summary) return "(a request with no summary)";
  const lines: string[] = [summary.action ?? "(an action)"];
  const bulk = summary.bulk;
  if (!bulk) {
    for (const d of summary.details ?? []) lines.push(`${d.label}: ${d.value}`);
    return lines.join("\n").slice(0, REQUEST_CLAMP);
  }
  const labels = bulk.fields.map((f) => f.label);
  lines.push(
    `${String(bulk.rows.length)} ${bulk.objectLabel} records, each with exactly what it sets:`,
  );
  bulk.rows.slice(0, ROWS_SHOWN).forEach((row, i) => {
    const sets: string[] = [];
    const keeps: string[] = [];
    labels.forEach((label, j) => {
      const value = row.new?.[j];
      if (value == null || value === "") keeps.push(label);
      else sets.push(`${label}=${value}`);
    });
    lines.push(
      `  ${String(i + 1)}. ${row.name ?? ""}: sets ${sets.join("; ") || "nothing"}${
        keeps.length > 0 ? ` | does NOT set: ${keeps.join(", ")}` : ""
      }`,
    );
  });
  if (bulk.rows.length > ROWS_SHOWN) {
    lines.push(`  ...and ${String(bulk.rows.length - ROWS_SHOWN)} more`);
  }
  return lines.join("\n").slice(0, REQUEST_CLAMP);
};

const QUESTIONS = [
  {
    name: "verdict",
    instructions:
      "Classify the person's message against the waiting request(s). When unsure, answer OTHER.",
    choices: [
      {
        value: "already",
        description:
          "It asks for something the waiting request(s) ALREADY do. Compare against the values shown, record by record (only the named record's own line counts): if that record already sets those values (for example the message wants 3 records in a city and 3 records already have that city), it is ALREADY, even when phrased as a correction or a complaint.",
      },
      {
        value: "change",
        description:
          "It changes what THIS request does: other values for the fields shown, more or fewer of these records, a field a record does NOT set yet, or a different target for this same action.",
      },
      {
        value: "new",
        description:
          "It asks for a SEPARATE task that can happen alongside this request, not instead of it: a different kind of update (another field than the ones this request sets, like changing the owner while this request sets employees), a different action, or a different object.",
      },
      {
        value: "cancel",
        description: "It asks to stop or cancel the request.",
      },
      {
        value: "other",
        description:
          "Anything else: a separate question, thanks, small talk, a status question, or saying to go ahead.",
      },
    ],
  },
] as const;

const context = (input: SupersedeInput): string =>
  [
    `An AI assistant named "${input.agentName}" is waiting for a person to approve the request(s) below before it runs them.`,
    "",
    ...input.held.flatMap((r, i) => [
      `Request ${String(i + 1)}:`,
      describeHeldRequest(r),
      "",
    ]),
    "While it waits, the person sent this message:",
    input.message.slice(0, MESSAGE_CLAMP),
  ].join("\n");

export const judgeSupersede = defineJudge<SupersedeInput, SupersedeVerdict>({
  name: "supersede",
  deadlineMs: SUPERSEDE_DEADLINE_MS,
  fallback: "keep",
  decide: async (input, ask) => {
    if (input.held.length === 0) return "keep";
    const { verdict } = await ask({
      context: context(input),
      questions: QUESTIONS,
      reason: true,
    });
    return verdict === "change" || verdict === "cancel" ? "replace" : "keep";
  },
  describe: (v) => v,
  logFields: (input) => ({ held: input.held.length }),
});
