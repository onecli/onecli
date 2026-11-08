export type RunTone = "ok" | "failed" | "running" | "skipped";

const DOT: Record<RunTone, string> = {
  ok: "bg-emerald-500",
  failed: "bg-destructive",
  running: "bg-amber-400",
  skipped: "bg-muted-foreground/50",
};

/** The Last run cell's dot: green ok, yellow running, red failed, grey
 * stopped or skipped. */
export const RunDot = ({ tone, label }: { tone: RunTone; label?: string }) => (
  <span
    aria-label={label}
    className={`size-1.5 shrink-0 rounded-full ${DOT[tone]}`}
  />
);
