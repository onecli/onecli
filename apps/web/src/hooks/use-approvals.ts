"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import {
  decide,
  listPending,
  type ApprovalDecisionInput,
  type PendingApproval,
} from "@/lib/api/approvals";
import { queryKeys } from "@/lib/api/keys";
import { hasWorkspaceContext } from "@/lib/navigation";

/**
 * Live list of pending approvals for the active workspace.
 *
 * The gateway long-polls `GET /v1/approvals/pending` (holds ~30s while idle),
 * so this is effectively a long-poll driven by React Query: a small
 * `refetchInterval` re-issues the request shortly after each one settles, and
 * React Query dedupes concurrent fetches so the held request is never doubled.
 * Net result — idle pages hold one ~30s connection; while approvals are pending
 * the gateway returns immediately and we poll ~1s (snappy add/remove). Only runs
 * where a workspace context exists (workspace pages in URL-scoped editions; every
 * dashboard page in single-workspace editions) and pauses in background tabs.
 */
export const usePendingApprovals = () => {
  const pathname = usePathname();

  return useQuery({
    queryKey: queryKeys.approvals.list(),
    queryFn: ({ signal }) =>
      listPending({
        signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      }),
    enabled: hasWorkspaceContext(pathname),
    // When the list is empty the gateway holds the request ~30s and returns the
    // instant a new approval appears — a true long-poll, so poll fast (1s). But
    // while approvals are already pending the endpoint returns immediately, so
    // back off to 5s to avoid ~1 req/s busy-polling. Own actions stay instant
    // via optimistic updates; external changes reflect within ≤5s. An erroring
    // poll (gateway down — a normal state on a self-hosted box) backs off to
    // 30s: `initialData` keeps `data` defined through errors, so without the
    // status check a dead gateway would be hammered on the 1s branch forever.
    refetchInterval: (query) =>
      query.state.status === "error"
        ? 30_000
        : query.state.data?.length
          ? 5_000
          : 1_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
    // Seed with an empty list so the popover shows its empty state instantly
    // instead of a skeleton during the gateway's ~30s idle long-poll hold.
    initialData: [],
  });
};

/**
 * Session memory of THIS browser's own decisions, keyed by approval id. The
 * chat's settled record consults it to say "Approved"/"Denied" precisely for
 * own clicks (a departure from the pending list alone cannot tell who
 * decided). Written on mutate, erased on rollback, consumed on read — the
 * map never outlives the one departure it explains.
 */
const localDecisions = new Map<string, "approved" | "denied">();

/** Read-and-forget an own-click outcome for a departed approval. */
export const takeLocalDecision = (
  id: string,
): "approved" | "denied" | undefined => {
  const outcome = localDecisions.get(id);
  localDecisions.delete(id);
  return outcome;
};

/** What useDecideApproval's onMutate records (exported for tests). */
export const recordLocalDecision = (
  id: string,
  outcome: "approved" | "denied",
): void => {
  localDecisions.set(id, outcome);
};

/** What useDecideApproval's onError does — a rollback must forget. */
export const forgetLocalDecision = (id: string): void => {
  localDecisions.delete(id);
};

/**
 * Approve or deny a held request. Optimistically removes the item from the
 * pending list, rolls back on error, and refreshes activity + counts on settle.
 * No gateway-cache invalidation — a decision releases a held request, it does
 * not change gateway config (rules/secrets).
 */
export const useDecideApproval = () => {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      decision,
    }: {
      id: string;
      decision: ApprovalDecisionInput;
    }) => decide(id, decision),
    onMutate: async ({ id, decision }) => {
      recordLocalDecision(id, decision === "approve" ? "approved" : "denied");
      await qc.cancelQueries({ queryKey: queryKeys.approvals.all() });
      const previous = qc.getQueryData<PendingApproval[]>(
        queryKeys.approvals.list(),
      );
      qc.setQueryData<PendingApproval[]>(queryKeys.approvals.list(), (old) =>
        old?.filter((a) => a.id !== id),
      );
      return { previous };
    },
    onError: (_err, vars, ctx) => {
      forgetLocalDecision(vars.id);
      if (ctx?.previous) {
        qc.setQueryData(queryKeys.approvals.list(), ctx.previous);
      }
      toast.error("Failed to submit decision");
    },
    onSuccess: (_data, { decision }) => {
      toast.success(
        decision === "approve" ? "Request approved" : "Request denied",
      );
    },
    onSettled: () => {
      // Only the pending list is a React Query resource; the Activity screen
      // refreshes via its own polling, and sidebar counts are unaffected.
      qc.invalidateQueries({ queryKey: queryKeys.approvals.all() });
    },
  });
};
