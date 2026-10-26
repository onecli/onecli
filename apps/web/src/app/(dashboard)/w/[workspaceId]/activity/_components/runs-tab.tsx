"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useRunsList } from "@/hooks/use-runs";
import type { RunListItem } from "@/lib/api";
import { RunDetailSheet } from "@/lib/agents/runs";
import { RUNS_VIEWS, type RunsView } from "@/lib/agents/runs/runs-view";
import { SegmentedFilter, type SegmentOption } from "./segmented-filter";
import { LiveToggle } from "./live-toggle";
import { RunsTable } from "./runs-table";
import { WebhookFilterChip } from "./webhook-filter-chip";

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
const LABEL: Record<RunsView, string> = {
  all: "All",
  web: "Web",
  slack: "Slack",
  cron: "Schedules",
  webhook: "Webhooks",
  eval: "Tests",
  failed: "Failed",
};
const VIEWS: readonly SegmentOption<RunsView>[] = RUNS_VIEWS.map((value) => ({
  value,
  label: LABEL[value],
}));

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
  webhookId,
  view,
  onViewChange,
  onClearWebhook,
  onViewNetwork,
}: {
  /** Narrow to one agent (from the URL). */
  agentId?: string;
  /** Narrow to one of that agent's webhooks (its "View runs"). Only honored
   * with an agent and the Webhooks filter, so the URL cannot combine it with
   * a filter it contradicts. */
  webhookId?: string;
  /** The segmented filter, kept in the URL so a link can open a view. */
  view: RunsView;
  onViewChange: (view: RunsView) => void;
  /** Widen back from one webhook to all of the agent's webhook runs. */
  onClearWebhook?: () => void;
  /** Show Network narrowed to this run's agent and time window. */
  onViewNetwork: (run: RunListItem) => void;
}) => {
  const [open, setOpen] = useState<RunListItem | null>(null);
  const oneWebhook =
    agentId && webhookId && view === "webhook" ? webhookId : undefined;
  const list = useRunsList({
    ...(agentId && { agentId }),
    ...(view === "failed"
      ? { failed: true }
      : view !== "all" && { source: view }),
    ...(oneWebhook && { webhookId: oneWebhook }),
  });

  const rows = list.pages.flatMap((page) => page.runs);
  const showApps = list.pages[0]?.appEvidenceWithheld === false;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedFilter
            options={VIEWS}
            value={view}
            onChange={onViewChange}
            label="Filter runs"
          />
          {agentId && oneWebhook && onClearWebhook && (
            <WebhookFilterChip
              agentId={agentId}
              webhookId={oneWebhook}
              onClear={onClearWebhook}
            />
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
            emptyMessage={
              oneWebhook ? "No runs from this webhook yet." : EMPTY[view]
            }
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
