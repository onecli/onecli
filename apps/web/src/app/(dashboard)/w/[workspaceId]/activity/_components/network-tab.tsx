"use client";

import { useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import type {
  ActivityFilter,
  ActivityPageParams,
} from "@onecli/api/validations/request-logs";
import type { RequestLogEntry } from "@onecli/api/services/request-log-service";
import { useActivityList } from "@/hooks/use-activity";
import { usePendingApprovals } from "@/hooks/use-approvals";
import { ApprovalDetailsDialog } from "@/lib/components/approvals";
import type { PendingApproval } from "@/lib/api/approvals";
import { ActivityTable } from "./activity-table";
import { ActivityFilterControl } from "./activity-filter";
import { LiveToggle } from "./live-toggle";
import { ActivityDetailDialog } from "./activity-detail-dialog";

const EMPTY_MESSAGES: Record<ActivityFilter, string> = {
  all: "No requests yet.",
  "hide-llm": "No non-AI requests to show.",
  blocked: "No blocked requests.",
};

/** Narrowing from the URL: one agent, and optionally a run's time window. */
export type NetworkScope = Pick<ActivityPageParams, "agentId" | "from" | "to">;

/** Activity's Network tab: every request through the gateway. */
export const NetworkTab = ({
  scope,
  onClearWindow,
}: {
  scope: NetworkScope;
  /** Drop the run's time window (the agent stays, in the picker). */
  onClearWindow: () => void;
}) => {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [selected, setSelected] = useState<RequestLogEntry | null>(null);
  const [approvalDetails, setApprovalDetails] =
    useState<PendingApproval | null>(null);
  const list = useActivityList({ filter, ...scope });

  const { data: pendingApprovals = [] } = usePendingApprovals();
  const liveApprovals = useMemo(
    () => new Map(pendingApprovals.map((a) => [a.id, a])),
    [pendingApprovals],
  );
  const logs = list.pages.flatMap((page) => page.logs);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ActivityFilterControl value={filter} onChange={setFilter} />
          {scope.from !== undefined && (
            <button
              type="button"
              onClick={onClearWindow}
              className="hover:bg-muted focus-visible:ring-ring flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs focus-visible:ring-2 focus-visible:outline-none"
            >
              During one run
              <X className="size-3" aria-hidden />
              <span className="sr-only">(clear)</span>
            </button>
          )}
        </div>
        <LiveToggle
          live={list.live}
          onToggle={() => list.setLive(!list.live)}
        />
      </div>

      {list.isPending ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
          <span className="sr-only">Loading requests</span>
        </div>
      ) : list.isError ? (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-4 text-sm"
        >
          Requests could not be loaded. Refresh to try again.
        </div>
      ) : (
        <>
          <ActivityTable
            logs={logs}
            liveApprovals={liveApprovals}
            onRowClick={setSelected}
            onShowApproval={setApprovalDetails}
            emptyMessage={EMPTY_MESSAGES[filter]}
          />
          {list.hasMore && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={list.loadMore}
                disabled={list.isLoadingMore}
              >
                {list.isLoadingMore && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                {list.isLoadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}

      <ActivityDetailDialog log={selected} onClose={() => setSelected(null)} />
      <ApprovalDetailsDialog
        approval={approvalDetails}
        onClose={() => setApprovalDetails(null)}
      />
    </div>
  );
};
