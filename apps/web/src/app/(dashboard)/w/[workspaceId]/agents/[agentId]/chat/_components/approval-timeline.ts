"use client";

import { useEffect, useState } from "react";
import {
  groupApprovals,
  type ApprovalGroup,
} from "@onecli/api/lib/approval-groups";
import type {
  ApprovalSummary,
  GroupedOutcome,
  PendingApproval,
} from "@/lib/api/approvals";
import { shareOneRecord } from "@/lib/components/approvals/approval-rows";
import type { SettledMember } from "@/lib/components/approvals/grouped-approval-card";
import type { ApprovalCard } from "./use-approval-cards";

/**
 * One timeline entry of approvals: a lone request (the single card), a live
 * task of several (the grouped card), or a finished task's Done record.
 */
export type ApprovalTimelineEntry =
  | { kind: "single"; at: number; card: ApprovalCard }
  | {
      kind: "group";
      at: number;
      key: string;
      /** The task's still-live requests: what Approve all can decide. */
      group: ApprovalGroup<PendingApproval>;
      /** Members already decided: they stay on the card with their outcome. */
      settled: SettledMember[];
    }
  | {
      kind: "done";
      at: number;
      key: string;
      count: number;
      action: string;
      /** Set when every request acted on one record, so it stays a link. */
      summary?: ApprovalSummary;
      counts: Record<GroupedOutcome, number>;
    };

/** A card a grouped card or Done record may hold: never a replaced one. */
type GroupableCard = ApprovalCard & { settled?: GroupedOutcome };

const isGroupable = (card: ApprovalCard): card is GroupableCard =>
  card.settled !== "replaced";

/**
 * Split one task's cards (creation order) into RUNS: a request made after
 * every earlier one had been decided is a new attempt ("do it again"), never
 * more rows on the finished card. Both times are the gateway's clock.
 */
const runsOf = (cards: GroupableCard[]): GroupableCard[][] => {
  const runs: GroupableCard[][] = [];
  let run: GroupableCard[] = [];
  let lastSettled = -Infinity;
  for (const c of cards) {
    if (run.length > 0 && run.every((m) => m.settled) && c.at > lastSettled) {
      runs.push(run);
      run = [];
      lastSettled = -Infinity;
    }
    run.push(c);
    // Unknown: never split on it (keep one card).
    if (c.settled) {
      lastSettled = Math.max(lastSettled, c.settledAt ?? Infinity);
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
};

/**
 * Fold the chat's approval cards into timeline entries, keyed by the shared
 * grouping (`@onecli/api/lib/approval-groups`), so the thread, the bell and
 * Slack agree on what one task is:
 *
 * - a run with a live request and 2+ members (or that the agent announced
 *   as several) is one grouped card at its first request's position, its
 *   settled members kept on it;
 * - a run of 2+ that has fully settled is one "Done" record;
 * - anything else stays a single card, exactly as before.
 */
export const approvalTimeline = (
  cards: readonly ApprovalCard[],
): ApprovalTimelineEntry[] => {
  // A REPLACED request is history the person already acted on: always its
  // own one-line record, never a row on (or the anchor of) a grouped card.
  // Its revision then stands alone as a full card with its table, the way
  // Slack shows it, whatever order the poll and the notice arrived in.
  const rest = cards.filter(isGroupable);
  const cardById = new Map(rest.map((c) => [c.approval.id, c]));
  const entries: ApprovalTimelineEntry[] = cards
    .filter((c) => !isGroupable(c))
    .map((card) => ({ kind: "single", at: card.at, card }));
  for (const task of groupApprovals(rest.map((c) => c.approval))) {
    const taskCards = task.approvals.flatMap((a) => cardById.get(a.id) ?? []);
    runsOf(taskCards).forEach((run, i) => {
      const [first] = run;
      if (!first) return;
      const key = i === 0 ? task.key : `${task.key}#${i}`;
      const live = run.filter((c) => !c.settled);
      // The agent said this task sends more than one request: a group from
      // its very first request, so the card never changes shape.
      const announced = (first.approval.batch?.total ?? 0) > 1;
      if (run.length === 1 && !(announced && live.length === 1)) {
        entries.push({ kind: "single", at: first.at, card: first });
        return;
      }
      const settled = run.flatMap((c) =>
        c.settled
          ? [
              {
                approval: c.approval,
                outcome: c.settled,
                via: c.via,
                result: c.result,
              },
            ]
          : [],
      );
      const [liveGroup] = groupApprovals(live.map((c) => c.approval));
      if (liveGroup) {
        entries.push({
          kind: "group",
          at: first.at,
          key,
          group: liveGroup,
          settled,
        });
        return;
      }
      const approvals = run.map((c) => c.approval);
      const counts: Record<GroupedOutcome, number> = {
        approved: 0,
        denied: 0,
        decided: 0,
        expired: 0,
      };
      for (const s of settled) counts[s.outcome] += 1;
      entries.push({
        kind: "done",
        at: first.at,
        key,
        count: run.length,
        action: groupApprovals(approvals)[0]?.mainAction ?? task.mainAction,
        summary: shareOneRecord(approvals) ? first.approval.summary : undefined,
        counts,
      });
    });
  }
  return entries.sort((a, b) => a.at - b.at);
};

/** How long a lone NEW request waits for siblings before it shows. Parallel
 *  requests reach the gateway a beat apart; without this the first one
 *  flashes as a single card and then turns into a group. */
export const GATHER_MS = 1_500;

/**
 * `approvalTimeline`, minus lone live requests until arrivals pause for
 * `GATHER_MS` (on the browser's own clock, so gateway clock skew can't hide a
 * card). A request that belongs to a group, or that the agent announced as
 * one of several, shows at once; whatever is on screen at mount is never
 * held (a reload must not hide cards).
 */
export const useApprovalTimeline = (
  cards: readonly ApprovalCard[],
): ApprovalTimelineEntry[] => {
  const entries = approvalTimeline(cards);
  const [released, setReleased] = useState<ReadonlySet<string> | null>(null);
  // The ids' content, not the array rebuilt every render, drives the effect
  // (approval ids are UUIDs, never holding a comma).
  const loneKey = entries
    .flatMap((e) =>
      e.kind === "single" && !e.card.settled ? [e.card.approval.id] : [],
    )
    .join(",");
  useEffect(() => {
    const lone = loneKey ? loneKey.split(",") : [];
    if (released === null) {
      setReleased(new Set(lone));
      return;
    }
    const fresh = lone.filter((id) => !released.has(id));
    if (fresh.length === 0) return;
    const t = setTimeout(
      () => setReleased((prev) => new Set([...(prev ?? []), ...fresh])),
      GATHER_MS,
    );
    return () => clearTimeout(t);
  }, [loneKey, released]);
  if (released === null) return entries;
  return entries.filter(
    (e) =>
      e.kind !== "single" ||
      !!e.card.settled ||
      released.has(e.card.approval.id),
  );
};
