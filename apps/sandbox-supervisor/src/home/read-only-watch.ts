import { readFileSync } from "node:fs";

/**
 * The durable home turning read-only under a running agent.
 *
 * A home on a filesystem mounted `errors=remount-ro` (ext4's usual setting)
 * turns read-only after one failed write to its storage, and from then on
 * EVERY write fails (`Read-only file system (os error 30)`) until a fresh
 * boot mounts it again. Nothing inside this container can undo that, and
 * nothing outside sees it: the container runs, the channel is up, and the
 * control plane keeps dispatching turns that all fail the same way (an
 * agent can answer every message with that error for hours).
 *
 * So the supervisor watches its own mount table and, the first time the
 * home reads unwritable (`ro`, `emergency_ro` or `shutdown`, below), reports
 * the sandbox unhealthy with the `home_read_only` code (the same exit a dead
 * harness takes). The control plane decides whether, and when, the restart
 * happens; this side only tells the truth.
 *
 * The mount table is the kernel's own word, read without touching the home
 * (a probe write would fail with the same error the agent sees, and would
 * add a write to a filesystem that just reported an IO fault).
 *
 * Read-only does NOT always read `ro`. Since Linux 6.15, ext4's
 * `errors=remount-ro` no longer flips the superblock read-only: it sets an
 * internal emergency flag, the table keeps `rw` and gains `emergency_ro`
 * (and a forced shutdown gains `shutdown`). On such a kernel, a home that
 * hit an ext4 error reads `rw,relatime,discard,emergency_ro` while every
 * write fails with os error 30. A watch for `ro` alone never fires on the
 * very fault it exists for.
 */

/** How often the mount table is read. A turn that hits the read-only home
 * fails within one tool call anyway; this bounds how long a sandbox nobody
 * is talking to stays wrongly "healthy". The read is one small procfs file. */
export const READ_ONLY_WATCH_INTERVAL_MS = 10_000;

/**
 * The mount options that each mean "no write to this filesystem will
 * succeed": `ro` (a plain read-only mount, or ext4 before 6.15),
 * `emergency_ro` (ext4's error response since 6.15) and `shutdown` (an ext4
 * forced shutdown, every operation fails). Exact options only: `ro` must
 * never match inside `errors=remount-ro`.
 */
const UNWRITABLE_OPTIONS: ReadonlySet<string> = new Set([
  "ro",
  "emergency_ro",
  "shutdown",
]);

/**
 * Whether `mountPoint` is mounted read-only according to a `/proc/mounts`
 * style table (any of `UNWRITABLE_OPTIONS`). Only the LAST entry for the
 * mount point counts: mounts stack, and the visible one is the most recent
 * (a backend may mount the home over another mount of the same path, which
 * then sits underneath it in the table). Fields are space-separated
 * with octal escapes for spaces, so the mount point is compared escaped.
 */
export const isMountReadOnly = (table: string, mountPoint: string): boolean => {
  const escaped = mountPoint.replaceAll(" ", "\\040");
  let options: string | undefined;
  for (const line of table.split("\n")) {
    const fields = line.split(" ");
    if (fields[1] === escaped && fields[3] !== undefined) options = fields[3];
  }
  return (
    options?.split(",").some((option) => UNWRITABLE_OPTIONS.has(option)) ??
    false
  );
};

export interface ReadOnlyWatchDeps {
  /** The mount table's text; defaults to `/proc/self/mounts`. */
  readMounts?: () => string;
  intervalMs?: number;
  /** The FIRST error reading the table (logged by the caller, never fatal).
   * Once per watch: a table that cannot be read on one tick (no procfs on a
   * dev machine) cannot be read on the next either, and a warning every 10
   * s for the life of a sandbox is noise, not news. */
  onReadError?: (error: unknown) => void;
}

/**
 * Watch `mountPoint` and call `onReadOnly` ONCE, the first time it reads
 * read-only. Returns the stop function. A table that cannot be read is not
 * evidence of anything: the watch keeps polling and reports the error.
 */
export const watchHomeReadOnly = (
  mountPoint: string,
  onReadOnly: () => void,
  deps: ReadOnlyWatchDeps = {},
): (() => void) => {
  const readMounts =
    deps.readMounts ?? (() => readFileSync("/proc/self/mounts", "utf8"));
  let fired = false;
  let reportedReadError = false;
  const check = (): void => {
    if (fired) return;
    let table: string;
    try {
      table = readMounts();
    } catch (error) {
      if (!reportedReadError) {
        reportedReadError = true;
        deps.onReadError?.(error);
      }
      return;
    }
    if (!isMountReadOnly(table, mountPoint)) return;
    fired = true;
    clearInterval(timer);
    onReadOnly();
  };
  const timer = setInterval(
    check,
    deps.intervalMs ?? READ_ONLY_WATCH_INTERVAL_MS,
  );
  // Never the reason this process stays alive.
  timer.unref();
  check();
  return () => clearInterval(timer);
};
