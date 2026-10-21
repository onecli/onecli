"use client";

import { useEffect, useRef, useState } from "react";
import {
  gatewayNow,
  takeLocalDecision,
  usePendingApprovals,
} from "@/hooks/use-approvals";
import type { PendingApproval, SettledOutcome } from "@/lib/api/approvals";
import { useApprovalOutcomes } from "@/hooks/use-approval-outcomes";
import {
  MAX_OUTCOME_IDS,
  type ApprovalOutcome,
  type ApprovalResult,
} from "@/lib/api/approval-outcomes";
import { useAgentPageAgentMaybe } from "../../_components/agent-page-frame";

const EMPTY: ReadonlySet<string> = new Set();

/** One chat-timeline approval row: the approval, when it fired, and how it
 * ended (undefined while still actionable). */
export interface ApprovalCard {
  approval: PendingApproval;
  /** ms epoch of the approval's creation — the timeline position. */
  at: number;
  /** Present once the approval left the pending set: how it ended. */
  settled?: SettledOutcome;
  /** The last time it was seen still pending, on the gateway's clock (like
   *  `at`): a lower bound on when it was decided. A request created after
   *  that reads as a new attempt, not a sibling (parallel siblings arrive a
   *  beat apart, on the same poll as each other). The API's record, when it
   *  answers, replaces this with the real decision time. */
  settledAt?: number;
  /** Where a person decided it, once the API's record says so: a channel
   *  provider id (`slack`) or `web`. */
  via?: string;
  /** What an approved request actually did upstream ("0 of 9 created"),
   *  once the API's record has it. */
  result?: ApprovalResult;
}

/**
 * The chat's approval cards, position-ready: live pending approvals for THIS
 * agent plus the session's settled ones (an approval that left the pending
 * set stays as a muted record row instead of vanishing). Rides the same
 * long-poll cache entry as the header bell (`usePendingApprovals`). The chat
 * thread interleaves these rows into the timeline itself.
 *
 * Session memory is in-memory only — a reload renders the transcript without
 * stale cards; the durable record is the agent's own follow-up message.
 */
export const useApprovalCards = (
  /** Approvals the person's newer message withdrew (from the transcript's
   * supersede notices): their departure reads "replaced". */
  replaced: ReadonlySet<string> = EMPTY,
): ApprovalCard[] => {
  const agent = useAgentPageAgentMaybe();
  const { data: approvals = [] } = usePendingApprovals();
  const mine = agent ? approvals.filter((a) => a.agent.id === agent.id) : [];

  // Both stores are keyed by agent id: the chat route keeps this hook mounted
  // across an agent switch, so unkeyed memory would carry one agent's settled
  // cards into another agent's timeline.
  const [settled, setSettled] = useState<Record<string, ApprovalCard[]>>({});
  const seen = useRef(
    new Map<string, Map<string, { approval: PendingApproval; at: number }>>(),
  );
  useEffect(() => {
    if (!agent) return;
    const agentId = agent.id;
    const seenForAgent =
      seen.current.get(agentId) ??
      new Map<string, { approval: PendingApproval; at: number }>();
    seen.current.set(agentId, seenForAgent);
    const liveIds = new Set(mine.map((a) => a.id));
    const now = gatewayNow();
    // Every id still live is stamped with this observation: the set changed,
    // so whatever just arrived was live beside it.
    for (const a of mine) seenForAgent.set(a.id, { approval: a, at: now });
    const departed: ApprovalCard[] = [];
    for (const [id, { approval, at: lastSeen }] of seenForAgent) {
      if (liveIds.has(id)) continue;
      seenForAgent.delete(id);
      departed.push({
        approval,
        at: new Date(approval.createdAt).getTime(),
        settledAt: lastSeen,
        // This browser's own click is recorded precisely (useDecideApproval
        // notes it on mutate, forgets it on rollback). Otherwise: left the
        // set at/near its deadline → the gateway's auto-deny; earlier → a
        // decision from some other surface.
        settled:
          takeLocalDecision(id) ??
          (replaced.has(id)
            ? "replaced"
            : new Date(approval.expiresAt).getTime() - 15_000 <= now
              ? "expired"
              : "decided"),
      });
    }
    setSettled((prev) => {
      const rows = (prev[agentId] ?? []).map((c) =>
        // The notice can land a beat after the card left the poll: a
        // "decided" record the transcript now names is a replacement.
        c.settled === "decided" && replaced.has(c.approval.id)
          ? { ...c, settled: "replaced" as const }
          : c,
      );
      const relabeled = rows.some((c, i) => c !== prev[agentId]?.[i]);
      // An id back in the live set means an optimistic removal was rolled
      // back (useDecideApproval failed): the settled record must give way to
      // the resurrected live card, or the approval renders twice under one
      // React key.
      const kept = rows.filter((c) => !liveIds.has(c.approval.id));
      if (!relabeled && kept.length === rows.length && departed.length === 0) {
        return prev;
      }
      return { ...prev, [agentId]: [...kept, ...departed] };
    });
    // `mine` is derived fresh each render; keying on its ids keeps this
    // effect from looping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, mine.map((a) => a.id).join(","), [...replaced].join(",")]);

  // Departures the API's record can say more about: one this browser only
  // guessed at ("decided" somewhere else) gets its real outcome, place and
  // time; an approved one (here or anywhere) gets what it actually did.
  // The most recent ones only: the read answers at most MAX_OUTCOME_IDS (it
  // refuses more), and a long session's oldest cards keep their reading.
  const asked = agent
    ? (settled[agent.id] ?? [])
        .flatMap((c) =>
          c.settled === "decided" || c.settled === "approved"
            ? [c.approval.id]
            : [],
        )
        .slice(-MAX_OUTCOME_IDS)
    : [];
  const record = useApprovalOutcomes(agent?.id, asked);

  if (!agent) return [];
  const agentId = agent.id;
  const liveNow = new Set(mine.map((a) => a.id));
  const settledRows = (settled[agentId] ?? []).filter(
    (c) => c.approval.agent.id === agentId && !liveNow.has(c.approval.id),
  );
  return [
    // Belt and braces: the store is per-agent AND every row is re-checked
    // against this agent, so a card can never surface under the wrong name.
    // A row whose id is live again is skipped too — the effect above prunes
    // it from the store one render later, and both rows key on the approval
    // id, so rendering the pair even once would collide.
    ...settledRows.map((c) => withRecord(c, record.get(c.approval.id))),
    ...mine.map((approval) => ({
      approval,
      at: new Date(approval.createdAt).getTime(),
    })),
  ].sort((a, b) => a.at - b.at);
};

/**
 * A settled card completed by the API's record. A guessed ending ("decided"
 * somewhere else) takes the real outcome, where it was decided, and WHEN,
 * on the server's clock, so a request the agent sends right after a decision
 * starts its own card rather than joining the decided one. An approval takes
 * its result: what the upstream actually did with it.
 */
const withRecord = (
  card: ApprovalCard,
  outcome: ApprovalOutcome | undefined,
): ApprovalCard => {
  if (!outcome) return card;
  if (card.settled === "decided") {
    return {
      ...card,
      settled: outcome.outcome,
      via: outcome.via,
      settledAt: Date.parse(outcome.decidedAt),
      result: outcome.result,
    };
  }
  return card.settled === "approved" && outcome.outcome === "approved"
    ? { ...card, result: outcome.result }
    : card;
};
