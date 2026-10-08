"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useRunsList } from "@/hooks/use-runs";
import type { RunListItem } from "@/lib/api";
import { RunDetailSheet } from "@/lib/agents/runs";
import { SegmentedFilter, type SegmentOption } from "./segmented-filter";
import { LiveToggle } from "./live-toggle";
import { RunsTable } from "./runs-table";

/**
 * Activity's Runs tab: every question an agent in this workspace answered,
 * newest first. Laid out like the Network tab (segmented filter, Live,
 * table); open a row for the full trace and a link to its requests.
 *
 * Members see their own questions and shared ones (evals, schedules,
 * webhooks, channel threads). Where roles are enforced, org admins also see
 * that colleagues asked privately, but not what: opening one is the read,
 * and it is recorded in the audit log.
 *
 * SECURITY: questions and answers are untrusted text, rendered as text.
 */
type RunsView =
  | "all"
  | "web"
  | "slack"
  | "cron"
  | "webhook"
  | "eval"
  | "failed";

const VIEWS: readonly SegmentOption<RunsView>[] = [
  { value: "all", label: "All" },
  { value: "web", label: "Web" },
  { value: "slack", label: "Slack" },
  { value: "cron", label: "Schedules" },
  { value: "webhook", label: "Webhooks" },
  { value: "eval", label: "Tests" },
  { value: "failed", label: "Failed" },
];

const EMPTY: Record<RunsView, string> = {
  all: "No runs yet.",
  web: "No runs from the web chat.",
  slack: "No runs from Slack.",
  cron: "No scheduled runs.",
  webhook: "No webhook runs.",
  eval: "No test runs.",
  failed: "No failed runs.",
};

export const RunsTab = ({
  agentId,
  onViewNetwork,
}: {
  /** Narrow to one agent (from the URL). */
  agentId?: string;
  /** Show Network narrowed to this run's agent and time window. */
  onViewNetwork: (run: RunListItem) => void;
}) => {
  const [view, setView] = useState<RunsView>("all");
  const [open, setOpen] = useState<RunListItem | null>(null);
  const list = useRunsList({
    ...(agentId && { agentId }),
    ...(view === "failed"
      ? { failed: true }
      : view !== "all" && { source: view }),
  });

  const rows = list.pages.flatMap((page) => page.runs);
  const showApps = list.pages[0]?.appEvidenceWithheld === false;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedFilter
          options={VIEWS}
          value={view}
          onChange={setView}
          label="Filter runs"
        />
        <LiveToggle
          live={list.live}
          onToggle={() => list.setLive(!list.live)}
        />
      </div>

      {list.isPending ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
          <span className="sr-only">Loading runs</span>
        </div>
      ) : list.isError ? (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-4 text-sm"
        >
          Runs could not be loaded. Refresh to try again.
        </div>
      ) : (
        <>
          <RunsTable
            runs={rows}
            showApps={showApps}
            onOpen={setOpen}
            emptyMessage={EMPTY[view]}
          />
          {list.hasMore && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={list.isLoadingMore}
                onClick={list.loadMore}
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

      <RunDetailSheet
        agentId={open?.agent.id ?? ""}
        turnId={open?.turnId ?? null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setOpen(null);
        }}
        onViewNetwork={open ? () => onViewNetwork(open) : undefined}
      />
    </div>
  );
};
