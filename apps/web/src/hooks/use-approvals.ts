"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import {
  decide,
  listPending,
  type ApprovalDecisionInput,
  type PendingApproval,
} from "@/lib/api/approvals";
import { listPendingChannelApprovals } from "@/lib/api/channel-approvals";
import * as channels from "@/lib/api/channels";
import type { ChannelProvider } from "@/lib/api/channels";
import { getWorkspaceId } from "@/lib/api-fetch";
import { queryKeys } from "@/lib/api/keys";
import { hasWorkspaceContext } from "@/lib/navigation";

/**
 * How far this browser's clock reads ahead of the gateway's, at most: every
 * approval is seen after the gateway created it, so the smallest `now -
 * createdAt` observed bounds the offset (exact up to the network delay).
 * Deadlines are the gateway's, so a skewed browser clock must never decide
 * when a card leaves. Infinity until an approval has been seen.
 */
let clockLag = Infinity;

const noteArrivals = (list: PendingApproval[]): PendingApproval[] => {
  const now = Date.now();
  for (const a of list) {
    const lag = now - Date.parse(a.createdAt);
    if (lag < clockLag) clockLag = lag;
  }
  return list;
};

/** The gateway's clock, estimated from this browser's (ms epoch). Falls
 *  back to the local clock before any approval has been seen. */
export const gatewayNow = (): number =>
  Date.now() - (Number.isFinite(clockLag) ? clockLag : 0);

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
  // An approval past its deadline is already auto-denied at the gateway, but
  // the refetch that drops it can sit in the gateway's ~30s idle long-poll.
  // Drop it locally the moment it expires (every surface then settles it as
  // "expired"), re-rendering exactly at the next deadline.
  const [now, setNow] = useState(() => Date.now());
  const query = useQuery({
    queryKey: queryKeys.approvals.list(),
    queryFn: ({ signal }) =>
      listPending({
        signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      }).then(noteArrivals),
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

  const all = query.data;
  // Each deadline moved onto this browser's clock (see `clockLag`); an
  // unknown or unparsable one leaves the request to the poll. Stable across
  // renders while nothing expires, so consumers keyed on the list (effects,
  // memos) don't churn every render.
  const live = useMemo(
    () => all.filter((a) => !(Date.parse(a.expiresAt) + clockLag <= now)),
    [all, now],
  );
  const nextDeadline = Math.min(
    ...live
      .map((a) => Date.parse(a.expiresAt) + clockLag)
      .filter(Number.isFinite),
  );
  const { refetch } = query;
  useEffect(() => {
    if (!Number.isFinite(nextDeadline)) return;
    const t = setTimeout(
      () => {
        setNow(Date.now());
        // Ask the gateway too, so the list catches up with its auto-deny.
        void refetch();
      },
      Math.max(0, nextDeadline - Date.now()) + 50,
    );
    return () => clearTimeout(t);
  }, [nextDeadline, refetch]);

  return live.length === all.length ? query : { ...query, data: live };
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
    onMutate: ({ id, decision }) => settleOptimistically(qc, [id], decision),
    onError: (_err, { id }, ctx) => {
      restorePending(qc, [id], ctx?.previous);
      toast.error("Failed to submit decision");
    },
    onSuccess: (outcome, { decision }) => {
      if (outcome === "already_settled") {
        // The card was stale: expired, decided from another surface, or the
        // gateway restarted. The click changed nothing — say that, quietly.
        toast.info("This request was already settled");
        return;
      }
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

/**
 * Decide several held requests at once: a grouped card's Approve all / Deny
 * all, and a row's own buttons. Exactly the ids passed (the ones the
 * reviewer saw at click time) are decided, each through the ordinary
 * per-approval decision endpoint, in parallel, so every decision is still
 * fenced and attributed on its own. All leave the list optimistically; the
 * ones that fail come back (and are returned as `failed`), with one toast
 * for the whole click.
 */
export const useDecideApprovals = () => {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({
      ids,
      decision,
    }: {
      ids: string[];
      decision: ApprovalDecisionInput;
    }) => {
      const outcomes = await Promise.all(
        ids.map((id) =>
          decide(id, decision).then(
            (outcome) => ({ id, outcome }),
            () => ({ id, outcome: "failed" as const }),
          ),
        ),
      );
      return {
        failed: outcomes.filter((o) => o.outcome === "failed").map((o) => o.id),
        stale: outcomes.filter((o) => o.outcome === "already_settled").length,
      };
    },
    onMutate: ({ ids, decision }) => settleOptimistically(qc, ids, decision),
    onSuccess: ({ failed, stale }, { ids, decision }, ctx) => {
      if (failed.length > 0) {
        restorePending(qc, failed, ctx?.previous);
        toast.error(
          `${failed.length} of ${ids.length} couldn't be submitted. Try again.`,
        );
        return;
      }
      const delivered = ids.length - stale;
      if (delivered === 0) {
        toast.info(
          ids.length === 1
            ? "This request was already settled"
            : "These requests were already settled",
        );
        return;
      }
      const verb = decision === "approve" ? "approved" : "denied";
      toast.success(
        delivered === 1 ? `Request ${verb}` : `${delivered} requests ${verb}`,
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.approvals.all() });
    },
  });
};

/** A decision's optimistic half: note the own click (the chat's settled
 *  record reads it), then drop the ids from the pending list. Returns the
 *  list as it was, to restore from. */
const settleOptimistically = async (
  qc: QueryClient,
  ids: string[],
  decision: ApprovalDecisionInput,
) => {
  const outcome = decision === "approve" ? "approved" : "denied";
  for (const id of ids) recordLocalDecision(id, outcome);
  await qc.cancelQueries({ queryKey: queryKeys.approvals.all() });
  const previous = qc.getQueryData<PendingApproval[]>(
    queryKeys.approvals.list(),
  );
  const gone = new Set(ids);
  qc.setQueryData<PendingApproval[]>(queryKeys.approvals.list(), (old) =>
    old?.filter((a) => !gone.has(a.id)),
  );
  return { previous };
};

/** Put back the ids whose decision did not go through, and forget their
 *  own-click record. Never twice: a poll may have brought one back already. */
const restorePending = (
  qc: QueryClient,
  ids: string[],
  previous: PendingApproval[] | undefined,
) => {
  for (const id of ids) forgetLocalDecision(id);
  const back = new Set(ids);
  qc.setQueryData<PendingApproval[]>(queryKeys.approvals.list(), (old = []) => {
    const present = new Set(old.map((a) => a.id));
    const missing = (previous ?? []).filter(
      (a) => back.has(a.id) && !present.has(a.id),
    );
    return [...old, ...missing];
  });
};

/**
 * The bell's CHANNEL arm (4d): pending action approvals + reach asks for the
 * workspace in the URL. Plain 15s poll — these asks live hours, not the
 * gateway prompt's seconds, so no long-poll ceremony. Same context gate as
 * the gateway arm.
 */
export const usePendingChannelApprovals = () => {
  const pathname = usePathname();
  const workspaceId = getWorkspaceId();

  return useQuery({
    queryKey: queryKeys.approvals.channel(workspaceId ?? "none"),
    queryFn: () => listPendingChannelApprovals(workspaceId as string),
    enabled: hasWorkspaceContext(pathname) && workspaceId !== undefined,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
};

/** Decide one action approval from the bell (approve / always-allow /
 * reject+reason) — the per-agent decide door, bell cache refreshed. */
export const useDecideChannelAction = (agentId: string) => {
  const qc = useQueryClient();
  const workspaceId = getWorkspaceId();
  return useMutation({
    mutationFn: (input: {
      approvalId: string;
      decision: "approve" | "approve_always" | "reject";
      reason?: string;
    }) =>
      channels.decideActionApproval(agentId, input.approvalId, {
        decision: input.decision,
        ...(input.reason !== undefined && { reason: input.reason }),
      }),
    onSuccess: () => {
      if (workspaceId) {
        qc.invalidateQueries({
          queryKey: queryKeys.approvals.channel(workspaceId),
        });
      }
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    },
  });
};

/** Decide one reach ask from the bell — space (3-way) or person (2-way),
 * through the existing per-agent reach doors. */
export const useDecideChannelReach = (agentId: string, provider: string) => {
  const qc = useQueryClient();
  const workspaceId = getWorkspaceId();
  return useMutation({
    mutationFn: (input: {
      externalRef: string;
      subjectKind: "space" | "external_user";
      state: "approved" | "members_only" | "blocked";
    }) =>
      input.subjectKind === "space"
        ? channels.setReachState(
            agentId,
            provider as ChannelProvider,
            input.externalRef,
            input.state,
          )
        : channels.setPersonReachState(
            agentId,
            provider as ChannelProvider,
            input.externalRef,
            input.state === "members_only" ? "blocked" : input.state,
          ),
    onSuccess: () => {
      if (workspaceId) {
        qc.invalidateQueries({
          queryKey: queryKeys.approvals.channel(workspaceId),
        });
      }
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    },
  });
};
