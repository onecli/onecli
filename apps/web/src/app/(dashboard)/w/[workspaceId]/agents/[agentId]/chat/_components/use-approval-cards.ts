"use client";

import { useEffect, useRef, useState } from "react";
import { takeLocalDecision, usePendingApprovals } from "@/hooks/use-approvals";
import type { PendingApproval } from "@/lib/api/approvals";
import { useAgentPageAgentMaybe } from "../../_components/agent-page-frame";

/** How a settled approval ended: this browser's own click ("approved" /
 * "denied"), some other surface's decision ("decided"), or the gateway's
 * auto-deny at the deadline ("expired"). */
export type SettledOutcome = "approved" | "denied" | "decided" | "expired";

/** One chat-timeline approval row: the approval, when it fired, and how it
 * ended (undefined while still actionable). */
export interface ApprovalCard {
  approval: PendingApproval;
  /** ms epoch of the approval's creation — the timeline position. */
  at: number;
  /** Present once the approval left the pending set: how it ended. */
  settled?: SettledOutcome;
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
export const useApprovalCards = (): ApprovalCard[] => {
  const agent = useAgentPageAgentMaybe();
  const { data: approvals = [] } = usePendingApprovals();
  const mine = agent ? approvals.filter((a) => a.agent.id === agent.id) : [];

  // Both stores are keyed by agent id: the chat route keeps this hook mounted
  // across an agent switch, so unkeyed memory would carry one agent's settled
  // cards into another agent's timeline.
  const [settled, setSettled] = useState<Record<string, ApprovalCard[]>>({});
  const seen = useRef(new Map<string, Map<string, PendingApproval>>());
  useEffect(() => {
    if (!agent) return;
    const agentId = agent.id;
    const seenForAgent =
      seen.current.get(agentId) ?? new Map<string, PendingApproval>();
    seen.current.set(agentId, seenForAgent);
    const liveIds = new Set(mine.map((a) => a.id));
    for (const a of mine) seenForAgent.set(a.id, a);
    const departed: ApprovalCard[] = [];
    for (const [id, approval] of seenForAgent) {
      if (liveIds.has(id)) continue;
      seenForAgent.delete(id);
      departed.push({
        approval,
        at: new Date(approval.createdAt).getTime(),
        // This browser's own click is recorded precisely (useDecideApproval
        // notes it on mutate, forgets it on rollback). Otherwise: left the
        // set at/near its deadline → the gateway's auto-deny; earlier → a
        // decision from some other surface.
        settled:
          takeLocalDecision(id) ??
          (new Date(approval.expiresAt).getTime() - 15_000 <= Date.now()
            ? "expired"
            : "decided"),
      });
    }
    setSettled((prev) => {
      const rows = prev[agentId] ?? [];
      // An id back in the live set means an optimistic removal was rolled
      // back (useDecideApproval failed): the settled record must give way to
      // the resurrected live card, or the approval renders twice under one
      // React key.
      const kept = rows.filter((c) => !liveIds.has(c.approval.id));
      if (kept.length === rows.length && departed.length === 0) return prev;
      return { ...prev, [agentId]: [...kept, ...departed] };
    });
    // `mine` is derived fresh each render; keying on its ids keeps this
    // effect from looping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, mine.map((a) => a.id).join(",")]);

  if (!agent) return [];
  const agentId = agent.id;
  const liveNow = new Set(mine.map((a) => a.id));
  return [
    // Belt and braces: the store is per-agent AND every row is re-checked
    // against this agent, so a card can never surface under the wrong name.
    // A row whose id is live again is skipped too — the effect above prunes
    // it from the store one render later, and both rows key on the approval
    // id, so rendering the pair even once would collide.
    ...(settled[agentId] ?? []).filter(
      (c) => c.approval.agent.id === agentId && !liveNow.has(c.approval.id),
    ),
    ...mine.map((approval) => ({
      approval,
      at: new Date(approval.createdAt).getTime(),
    })),
  ].sort((a, b) => a.at - b.at);
};
