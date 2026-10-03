"use client";

import { Message, MessageContent } from "@onecli/ui/components/message";
import { GroupedApprovalCard } from "@/lib/components/approvals/grouped-approval-card";
import { ApprovalGroupDone } from "./approval-group-done";
import { ApprovalGroupStack } from "./approval-group-stack";
import type { ApprovalTimelineEntry } from "./approval-timeline";
import { InlineApprovalItem } from "./inline-approval-item";

type GroupEntry = Extract<ApprovalTimelineEntry, { kind: "group" }>;

/** Consecutive live tasks, merged: they render as one sectioned card. */
const mergeAdjacentGroups = (entries: ApprovalTimelineEntry[]) => {
  const out: (Exclude<ApprovalTimelineEntry, GroupEntry> | GroupEntry[])[] = [];
  for (const entry of entries) {
    const last = out[out.length - 1];
    if (entry.kind !== "group") out.push(entry);
    else if (Array.isArray(last)) last.push(entry);
    else out.push([entry]);
  }
  return out;
};

/**
 * One slot's approvals in the thread: single cards, grouped cards, and
 * Done records. Parallel live tasks raised together read as one sectioned
 * card, never as a pile of look-alike cards.
 */
export const ApprovalTimelineSlot = ({
  entries,
}: {
  entries: ApprovalTimelineEntry[];
}) =>
  mergeAdjacentGroups(entries).map((entry) => {
    if (Array.isArray(entry)) {
      const [first] = entry;
      return (
        <Message key={first?.key} align="start">
          <MessageContent className="w-full max-w-[80%]">
            {entry.length === 1 && first ? (
              <GroupedApprovalCard
                group={first.group}
                settled={first.settled}
              />
            ) : (
              <ApprovalGroupStack groups={entry} />
            )}
          </MessageContent>
        </Message>
      );
    }
    if (entry.kind === "done") {
      return (
        <ApprovalGroupDone
          key={entry.key}
          count={entry.count}
          action={entry.action}
          summary={entry.summary}
          counts={entry.counts}
        />
      );
    }
    return (
      <InlineApprovalItem
        key={entry.card.approval.id}
        approval={entry.card.approval}
        settled={entry.card.settled}
      />
    );
  });
