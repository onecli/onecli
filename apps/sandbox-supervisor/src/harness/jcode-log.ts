import { join } from "node:path";
import { log } from "../log";
import { createFileFollower, type FileFollower } from "../logs/file-follower";
import { createRateLimiter } from "../logs/rate-limiter";
import { redactSecrets } from "../logs/redact";

/**
 * The jcode daemon's own log, re-emitted through the supervisor's logger.
 *
 * jcode writes almost everything it knows (provider errors, stream
 * lifecycles, interrupts, turn completion) to `<JCODE_HOME>/logs/jcode-
 * <date>.log`, a file on the agent's home volume that no platform
 * component reads. Measured on the pinned build: 2 lines reach the daemon's
 * stderr, 32+ reach the file, and #1124's root cause was only provable from
 * that file. Re-emitting it through
 * `log()` puts it on the supervisor's stderr, which every substrate already
 * collects (`docker logs` on self-host).
 *
 * Vendor-specific by construction (the line format, the level vocabulary,
 * the noise families), which is why it lives beside jcode.ts and nowhere
 * above the harness seam (invariant 9).
 */

/** Matches `jcode-YYYY-MM-DD.log` only, never the memory/ telemetry dir. */
export const JCODE_LOG_FILE = /^jcode-\d{4}-\d{2}-\d{2}\.log$/;

/** The entry header: `[2026-10-01 13:54:13.349] [ERROR] message…`. */
const ENTRY_HEADER = /^\[(\d{4}-\d{2}-\d{2} [\d:.]+)\] \[([A-Z]+)\] ?(.*)$/;

type LogLevel = "info" | "warn" | "error";

/**
 * jcode's level vocabulary → ours. ERROR and WARN keep their meaning; every
 * other tag (INFO, AUTH, DEBUG, TRACE…) is informational. An unknown future
 * tag degrades to info rather than being dropped.
 */
const levelOf = (tag: string): LogLevel => {
  if (tag === "ERROR") return "error";
  if (tag === "WARN") return "warn";
  return "info";
};

/**
 * INFO families that are pure process telemetry: dropped, never forwarded.
 * A DENY list (the user's call, 2026-10-01): everything else at INFO is
 * kept, so a new upstream event family is visible by default. Measured on a
 * real agent run: `Ambient runner:` alone was 149 of 281 lines.
 *
 * Matched against the message with any `[srv:…]`/`[ses:…]` context prefix
 * stripped. WARN/ERROR are never filtered, whatever they say.
 */
const INFO_NOISE: readonly RegExp[] = [
  /^Ambient runner: /,
  /^perf: /,
  /^power_inhibit: /,
  /^\[TIMING\] /,
  /^Runtime memory logging enabled/,
  /^Session search index warmup/,
  /^Registry prewarm completed/,
  /^Embedding model not installed/,
  /^No clients connected\. Server will exit/,
];

const CONTEXT_PREFIX = /^(?:\[(?:srv|ses|prv|mod):[^\]]*\]\s*)+/;

export const isInfoNoise = (message: string): boolean => {
  const bare = message.replace(CONTEXT_PREFIX, "");
  return INFO_NOISE.some((pattern) => pattern.test(bare));
};

/** One assembled jcode log entry (header line + continuation lines). */
export interface JcodeLogEntry {
  level: LogLevel;
  /** The daemon's own timestamp, verbatim (local wall clock, no zone). */
  at: string;
  message: string;
}

/** Continuation lines kept per entry; a runaway multi-line dump is cut. */
const MAX_CONTINUATION_LINES = 50;
/** Characters kept per entry message (after redaction). */
export const MAX_ENTRY_CHARS = 8_000;

/**
 * Assembles physical lines into entries: jcode writes multi-line messages
 * (`Caused by:` chains, pretty-printed frames) as a header line followed by
 * header-less continuation lines. A line that matches no header and follows
 * no entry is forwarded as its own info entry rather than lost.
 */
export const createEntryAssembler = (
  onEntry: (entry: JcodeLogEntry) => void,
) => {
  let current: { entry: JcodeLogEntry; continuation: number } | undefined;

  const flush = (): void => {
    if (current) onEntry(current.entry);
    current = undefined;
  };

  return {
    push(line: string): void {
      const header = ENTRY_HEADER.exec(line);
      if (header) {
        flush();
        current = {
          entry: {
            level: levelOf(header[2] ?? ""),
            at: header[1] ?? "",
            message: header[3] ?? "",
          },
          continuation: 0,
        };
        return;
      }
      if (!current) {
        if (line.trim() !== "")
          onEntry({ level: "info", at: "", message: line });
        return;
      }
      if (current.continuation < MAX_CONTINUATION_LINES) {
        current.entry.message += `\n${line}`;
      }
      current.continuation += 1;
    },
    flush,
  };
};

export interface JcodeLogForwarderOptions {
  /** The instance's JCODE_HOME; the log directory is `<home>/logs`. */
  jcodeHome: string;
  pollIntervalMs?: number;
  /** Sustained entries/second forwarded (a bounded burst rides on top). */
  ratePerSecond?: number;
  burst?: number;
  now?: () => number;
}

/** Defaults sized for a busy agent: a turn produces tens of entries, a
 * provider retry storm a few hundred, never thousands per second. */
const DEFAULT_RATE_PER_SECOND = 20;
const DEFAULT_BURST = 500;

/**
 * Follow the jcode log and forward each entry through `log()` with
 * `source: "jcode"`, after the noise filter, redaction, and the rate cap.
 * Suppressed counts ride the next forwarded entry (`suppressed`), and a
 * skipped backlog is reported once, so a gap always says how big it was.
 */
export const startJcodeLogForwarder = (
  options: JcodeLogForwarderOptions,
): FileFollower => {
  const limiter = createRateLimiter({
    ratePerSecond: options.ratePerSecond ?? DEFAULT_RATE_PER_SECOND,
    burst: options.burst ?? DEFAULT_BURST,
    ...(options.now && { now: options.now }),
  });

  const forward = (entry: JcodeLogEntry): void => {
    if (entry.level === "info" && isInfoNoise(entry.message)) return;
    if (!limiter.tryTake()) return;
    const suppressed = limiter.takeSuppressed();
    log(entry.level, redactSecrets(entry.message).slice(0, MAX_ENTRY_CHARS), {
      source: "jcode",
      ...(entry.at && { jcodeTime: entry.at }),
      ...(suppressed > 0 && { suppressed }),
    });
  };

  const assembler = createEntryAssembler(forward);
  let errorReported = false;

  return createFileFollower({
    dir: join(options.jcodeHome, "logs"),
    match: JCODE_LOG_FILE,
    onLine: (line) => assembler.push(line),
    // Every tick ends the entries it read: a header with no successor yet
    // is complete as far as the file says (continuation lines are written
    // in the same flush as their header).
    onFlush: () => assembler.flush(),
    onSkip: (bytes) =>
      log("warn", "jcode log backlog skipped", { source: "jcode", bytes }),
    onError: (error) => {
      // Once per process: a persistent fs failure must not become its own
      // log flood.
      if (errorReported) return;
      errorReported = true;
      log("warn", "jcode log follower failed; retrying silently", {
        error: String(error),
      });
    },
    ...(options.pollIntervalMs !== undefined && {
      pollIntervalMs: options.pollIntervalMs,
    }),
  });
};

/** Bound per forwarded stderr chunk: the daemon's stderr is a crash
 * channel, not a stream; anything longer is a dump. */
const MAX_STDERR_CHARS = 4_000;

/**
 * Forward the daemon process's own stderr (startup failures, panics). The
 * SDK pipes it and keeps only a 4000-char tail it surfaces on startup
 * failure, so a crash AFTER startup is otherwise invisible. Bounded and
 * redacted like the file; never throws.
 */
export const forwardJcodeStderr = (
  stream: NodeJS.ReadableStream | null | undefined,
): void => {
  if (!stream) return;
  const limiter = createRateLimiter({ ratePerSecond: 5, burst: 50 });
  let partial = "";
  stream.on("data", (chunk: Buffer | string) => {
    partial += chunk.toString();
    const lines = partial.split("\n");
    partial = (lines.pop() ?? "").slice(-MAX_STDERR_CHARS);
    for (const line of lines) {
      if (line.trim() === "" || !limiter.tryTake()) continue;
      log("warn", redactSecrets(line).slice(0, MAX_STDERR_CHARS), {
        source: "jcode-stderr",
      });
    }
  });
  // A broken pipe on a dying daemon is expected; an unlistened "error"
  // would crash the supervisor instead.
  stream.on("error", () => undefined);
};
