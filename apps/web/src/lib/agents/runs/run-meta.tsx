import type { RunDetail } from "@/lib/api";
import { formatTimestamp } from "@/lib/format-timestamp";
import { runAskedBy, runDuration } from "./run-format";
import { RunSourceBadge } from "./run-source-badge";
import { RunStatusBadge } from "./run-status-badge";

/** Who asked, when, from where, how it ended and how long it took. */
export const RunMeta = ({ run }: { run: RunDetail }) => {
  const duration = runDuration(run.durationMs);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <time dateTime={run.createdAt}>{formatTimestamp(run.createdAt)}</time>
      <span aria-hidden>·</span>
      <span>{runAskedBy(run.askedBy)}</span>
      <RunSourceBadge source={run.source} />
      <RunStatusBadge status={run.status} />
      {duration && <span className="tabular-nums">{duration}</span>}
    </span>
  );
};
