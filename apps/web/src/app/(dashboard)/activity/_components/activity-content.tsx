"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Radio } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { PageHeader } from "@dashboard/page-header";
import { getActivityPage } from "@/lib/actions/request-logs";
import { ActivityTable } from "./activity-table";
import { ActivityDetailDialog } from "./activity-detail-dialog";
import type { RequestLogEntry } from "@onecli/api/services/request-log-service";

type StatusFilter = "all" | "errors";

export const ActivityContent = () => {
  const [logs, setLogs] = useState<RequestLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<{
    createdAt: string;
    id: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [liveMode, setLiveMode] = useState(true);
  const [selected, setSelected] = useState<RequestLogEntry | null>(null);
  const initializedRef = useRef(false);

  const loadInitial = useCallback(async (filter: StatusFilter) => {
    setLoading(true);
    try {
      const data = await getActivityPage({ statusFilter: filter });
      setLogs(data.logs);
      setNextCursor(data.nextCursor);
      initializedRef.current = true;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    initializedRef.current = false;
    loadInitial(statusFilter);
  }, [statusFilter, loadInitial]);

  useEffect(() => {
    if (!liveMode || loading) return;
    const id = setInterval(async () => {
      if (!initializedRef.current) return;
      try {
        const data = await getActivityPage({ statusFilter });
        setLogs((prev) => {
          if (
            prev.length === data.logs.length &&
            prev[0]?.id === data.logs[0]?.id
          )
            return prev;
          return data.logs;
        });
        setNextCursor(data.nextCursor);
      } catch {
        // Best-effort polling — stale data shown until next successful tick
      }
    }, 3000);
    return () => clearInterval(id);
  }, [liveMode, statusFilter, loading]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLiveMode(false);
    setLoadingMore(true);
    try {
      const data = await getActivityPage({ cursor: nextCursor, statusFilter });
      setLogs((prev) => [...prev, ...data.logs]);
      setNextCursor(data.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6">
      <PageHeader
        title="Activity"
        description="Request logs from your gateway. Bodies and query strings are never recorded."
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-lg border p-1">
          <button
            type="button"
            onClick={() => setStatusFilter("all")}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              statusFilter === "all"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter("errors")}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              statusFilter === "errors"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Blocked
          </button>
        </div>

        <button
          type="button"
          onClick={() => setLiveMode((v) => !v)}
          className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
        >
          <Radio
            className={`size-3.5 ${liveMode ? "text-green-500 animate-pulse" : "text-muted-foreground"}`}
          />
          Live
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      ) : (
        <>
          <ActivityTable logs={logs} onRowClick={setSelected} />

          {nextCursor && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore && <Loader2 className="size-3.5 animate-spin" />}
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      <ActivityDetailDialog log={selected} onClose={() => setSelected(null)} />
    </div>
  );
};
