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
import { PROJECT_PATH_RE } from "@/lib/navigation";

/**
 * Live list of pending approvals for the active project.
 *
 * The gateway long-polls `GET /v1/approvals/pending` (holds ~30s while idle),
 * so this is effectively a long-poll driven by React Query: a small
 * `refetchInterval` re-issues the request shortly after each one settles, and
 * React Query dedupes concurrent fetches so the held request is never doubled.
 * Net result — idle pages hold one ~30s connection; while approvals are pending
 * the gateway returns immediately and we poll ~1s (snappy add/remove). Only runs
 * on project pages and pauses in background tabs.
 */
export const usePendingApprovals = () => {
  const pathname = usePathname();
  const onProjectPage = PROJECT_PATH_RE.test(pathname);

  return useQuery({
    queryKey: queryKeys.approvals.list(),
    queryFn: ({ signal }) =>
      listPending({
        signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      }),
    enabled: onProjectPage,
    // When the list is empty the gateway holds the request ~30s and returns the
    // instant a new approval appears — a true long-poll, so poll fast (1s). But
    // while approvals are already pending the endpoint returns immediately, so
    // back off to 5s to avoid ~1 req/s busy-polling. Own actions stay instant
    // via optimistic updates; external changes reflect within ≤5s.
    refetchInterval: (query) => (query.state.data?.length ? 5_000 : 1_000),
    refetchIntervalInBackground: false,
    staleTime: 0,
    // Seed with an empty list so the popover shows its empty state instantly
    // instead of a skeleton during the gateway's ~30s idle long-poll hold.
    initialData: [],
  });
};

export const usePendingApprovalCount = (): number => {
  const { data } = usePendingApprovals();
  return data?.length ?? 0;
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
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: queryKeys.approvals.all() });
      const previous = qc.getQueryData<PendingApproval[]>(
        queryKeys.approvals.list(),
      );
      qc.setQueryData<PendingApproval[]>(queryKeys.approvals.list(), (old) =>
        old?.filter((a) => a.id !== id),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(queryKeys.approvals.list(), ctx.previous);
      }
      toast.error("Failed to submit decision");
    },
    onSuccess: (_data, { decision }) => {
      toast.success(
        decision === "approve" ? "Request approved" : "Request rejected",
      );
    },
    onSettled: () => {
      // Only the pending list is a React Query resource; the Activity screen
      // refreshes via its own polling, and sidebar counts are unaffected.
      qc.invalidateQueries({ queryKey: queryKeys.approvals.all() });
    },
  });
};
