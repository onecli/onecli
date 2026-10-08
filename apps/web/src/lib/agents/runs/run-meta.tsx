import type { RunDetail } from "@/lib/api";
import { formatTimestamp } from "@/lib/format-timestamp";
import { RunSourceBadge } from "./run-source-badge";
import { RunStatusBadge } from "./run-status-badge";

/** Who asked, when, from where, how it ended and how long it took. */
export const RunMeta = ({ run }: { run: RunDetail }) => (
  <span className="flex flex-wrap items-center gap-2">
    <time dateTime={run.createdAt}>{formatTimestamp(run.createdAt)}</time>
    <span aria-hidden>·</span>
    <span>{run.askedBy?.name ?? run.askedBy?.email ?? "Platform"}</span>
    <RunSourceBadge source={run.source} />
    <RunStatusBadge status={run.status} />
    {run.durationMs !== null && (
      <span className="tabular-nums">
        {(run.durationMs / 1000).toFixed(1)} s
      </span>
    )}
  </span>
);
