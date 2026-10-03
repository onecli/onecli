"use client";

import { Message, MessageContent } from "@onecli/ui/components/message";
import type { ApprovalSummary, SettledOutcome } from "@/lib/api/approvals";
import { ApprovalTitle } from "@/lib/components/approvals/approval-title";

/** Each outcome as the Done line says it, in the order it lists them. */
const OUTCOME_COPY: [SettledOutcome, string][] = [
  ["approved", "approved"],
  ["denied", "denied"],
  ["expired", "expired"],
  ["decided", "decided elsewhere"],
];

/** The quiet record a finished task leaves in the thread: what it was and
 *  how it ended ("3 × Create Contact · Done: 2 approved, 1 denied"). */
export const ApprovalGroupDone = ({
  count,
  action,
  summary,
  counts,
}: {
  count: number;
  /** The task's main action ("Create Contact"). */
  action: string;
  /** Set when every request acted on one record: the title links it. */
  summary?: ApprovalSummary;
  counts: Record<SettledOutcome, number>;
}) => {
  const parts = OUTCOME_COPY.filter(([o]) => counts[o] > 0).map(
    ([o, copy]) => `${counts[o]} ${copy}`,
  );
  return (
    <Message align="start">
      <MessageContent>
        <div
          role="status"
          className="bg-muted/50 text-muted-foreground flex w-fit max-w-[80%] items-baseline gap-1 rounded-xl border px-4 py-2 text-sm"
        >
          <span className="min-w-0 truncate font-medium">
            {count} × <ApprovalTitle summary={summary} fallback={action} />
          </span>
          <span className="shrink-0">· Done: {parts.join(", ")}</span>
        </div>
      </MessageContent>
    </Message>
  );
};
