import type { RunDetail } from "@/lib/api";

/** Who asked: their name, else their email, else the platform itself (a
 *  schedule, a webhook, an eval). */
export const runAskedBy = (askedBy: RunDetail["askedBy"]): string =>
  askedBy?.name ?? askedBy?.email ?? "Platform";

/** How long a run took, in seconds, or null while it has no end. */
export const runDuration = (durationMs: number | null): string | null =>
  durationMs === null ? null : `${(durationMs / 1000).toFixed(1)} s`;
