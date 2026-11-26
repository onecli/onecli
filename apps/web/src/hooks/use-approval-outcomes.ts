"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { approvalOutcomes } from "@/lib/api";
import type { ApprovalOutcome } from "@/lib/api/approval-outcomes";
import { queryKeys } from "@/lib/api/keys";

/** How long to keep asking about an id the record can't fully answer yet:
 * the decision's rows land a beat after the gateway lets the request go,
 * and an approved request's RESULT only once the upstream has answered. */
const RETRY_MS = 2_000;
const MAX_TRIES = 8;

/** Answered for good: how it ended, and for an approval, what it did. */
const isFinal = (o: ApprovalOutcome | undefined): boolean =>
  !!o && (o.outcome !== "approved" || !!o.result);

/**
 * How the agent's approvals in `ids` ended, from the API's record (outcome,
 * where, when, and for an approved request what the upstream did), keyed by
 * approval id. An id the record never names keeps its local reading. A new
 * departure changes the id set (so the query key): the previous answer
 * stays on screen until the new one lands, so settled cards never flicker
 * back to their guess.
 */
export const useApprovalOutcomes = (
  agentId: string | undefined,
  ids: readonly string[],
): ReadonlyMap<string, ApprovalOutcome> => {
  const sorted = [...ids].sort();
  const { data = [] } = useQuery({
    queryKey: queryKeys.approvals.outcomes(agentId ?? "", sorted),
    queryFn: () => approvalOutcomes.list(agentId ?? "", sorted),
    enabled: !!agentId && sorted.length > 0,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const got = new Map(
        (query.state.data ?? []).map((o) => [o.approvalId, o]),
      );
      const pending = sorted.some((id) => !isFinal(got.get(id)));
      return pending && query.state.dataUpdateCount < MAX_TRIES
        ? RETRY_MS
        : false;
    },
  });
  return new Map(data.map((o) => [o.approvalId, o]));
};
