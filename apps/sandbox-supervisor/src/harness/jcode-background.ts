import { createReadStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
  HarnessBackgroundTask,
  HarnessBackgroundTasks,
} from "@onecli/agent-protocol";
import { log } from "../log";

/**
 * jcode's background-task registry, read the way jcode itself writes it
 * (verified against v0.71.1 source, the exact vendored commit; re-verified
 * at the v0.78.1 and v0.81.1 pin bumps — format byte-identical, plus one
 * additive field: `stall_wake_seconds` arms a jcode-internal stall watchdog
 * independent of the task's own `wake` flag. "stalled" is only a WAIT
 * reason, never a status, so the enum below stays exact and the passthrough
 * absorbs the field). Everything vendor-format-specific lives HERE — the
 * generic observer never sees a file (invariant 9).
 *
 * The registry: `$TMPDIR/jcode-bg-tasks/<id>.status.json` (rich task state,
 * rewritten whole on every change) + `<id>.output` (append-only interleaved
 * output). Both die with the container — which is exactly the lost-sweep
 * model the control plane already owns.
 *
 * Two format facts that shape the mapping:
 * - `notify` serde-defaults TRUE on every background bash call, while `wake`
 *   defaults false and is the completion path's wake key. Under external
 *   wake ownership (JCODE_WAKE_MODE=external, v0.81+) the daemon no longer
 *   runs a self-wake turn for it — it emits a `wake_requested` event, which
 *   the adapter deliberately DROPS for completions (jcode-wake.ts): THIS
 *   mirror is that wake's single producer (poll-derived, durable, with the
 *   real output tail), and two producers would double-wake every task. The
 *   platform's wake intent is `wake` ALONE — treating notify as wake intent
 *   would fire a platform wake turn for every fire-and-forget task.
 * - `spawn_with_notify` also registers jcode-internal work (its self-dev
 *   build queue, communicate) under other `tool_name`s; only `bash` tasks
 *   are the agent's background work, so only those are mirrored.
 *
 * Caveat inherited from the source: jcode's daemon writes output LINE by
 * line, so a task emitting without newlines reads as silent until its next
 * newline (silence watches inherit that granularity).
 */

const statusFileSchema = z
  .object({
    // A safe token — never a path. This registry lives in an AGENT-WRITABLE
    // dir, and task_id is joined into the `.output` path below; the charset
    // makes traversal (`..`, `/`) unrepresentable and keeps CP refs clean.
    task_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
    tool_name: z.string(),
    display_name: z.string().nullish(),
    status: z.enum(["running", "completed", "failed", "superseded"]),
    exit_code: z.number().int().nullish(),
    error: z.string().nullish(),
    started_at: z.string(),
    completed_at: z.string().nullish(),
    notify: z.boolean().default(true),
    wake: z.boolean().default(false),
  })
  .passthrough();

/** jcode's cancel path records a Failed status with this exact error. */
const CANCELLED_ERROR = "Cancelled by user";

/** A real status file is a few KB (≤50-event history). Anything larger is
 * not jcode's — skip it unread rather than pull it into memory. */
const MAX_STATUS_BYTES = 64_000;
/** Bound the scan: this dir is agent-writable, so a flood of forged files
 * must not turn each poll into unbounded work. Real sessions have a handful
 * of tasks; 256 is generous headroom over the 20-task mirror cap. */
const MAX_STATUS_FILES_PER_POLL = 256;
/** Cap on new output consumed per task per poll. */
const MAX_DELTA_BYTES = 64_000;
/** Beyond this backlog, skip ahead — the tail ring keeps only the end
 * anyway, and reading a runaway file at 64k/poll would lag forever. */
const MAX_BACKLOG_BYTES = 512_000;
/** Distinctive marker (never plausibly a user's watch pattern). */
const GAP_MARKER =
  "\n[…onecli: output gap — task wrote faster than the observer reads…]\n";

const mapStatus = (
  parsed: z.infer<typeof statusFileSchema>,
): { status: "running" | "exited" | "stopped"; error?: string } => {
  if (parsed.status === "running") return { status: "running" };
  if (parsed.status === "failed" && parsed.error === CANCELLED_ERROR) {
    return { status: "stopped" };
  }
  return {
    status: "exited",
    ...(parsed.error ? { error: parsed.error } : {}),
  };
};

/** Read [offset, offset+limit) of a file as UTF-8, tolerating truncation. */
const readSlice = async (
  path: string,
  offset: number,
  limit: number,
): Promise<string> => {
  const chunks: Buffer[] = [];
  const stream = createReadStream(path, {
    start: offset,
    end: offset + limit - 1,
  });
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export const createJcodeBackgroundTasks = (options?: {
  dir?: string;
}): HarnessBackgroundTasks => {
  // The daemon computes its registry from the SAME tmpdir this process sees
  // (one container, one /tmp).
  const dir = options?.dir ?? join(tmpdir(), "jcode-bg-tasks");
  /** Per-task consumed-output offsets (bytes). */
  const offsets = new Map<string, number>();
  /** Non-bash tool_names we already mentioned. */
  const skippedTools = new Set<string>();
  let floodWarned = false;

  return {
    async poll(): Promise<HarnessBackgroundTask[]> {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        return []; // no registry yet — no tasks have ever started
      }

      const statusNames = names.filter((n) => n.endsWith(".status.json"));
      if (statusNames.length > MAX_STATUS_FILES_PER_POLL && !floodWarned) {
        floodWarned = true;
        log("warn", "background-task registry over the per-poll scan cap", {
          count: statusNames.length,
        });
      }

      const tasks: HarnessBackgroundTask[] = [];
      for (const name of statusNames.slice(0, MAX_STATUS_FILES_PER_POLL)) {
        let parsed: z.infer<typeof statusFileSchema>;
        try {
          const path = join(dir, name);
          // The dir is agent-writable: a non-regular file (a named pipe, a
          // dir) or an oversized one would hang or bloat the read, so gate on
          // an lstat FIRST — lstat (not stat) also refuses a symlink, so no
          // read is ever followed out of this dir.
          const st = await fs.lstat(path);
          if (!st.isFile() || st.size > MAX_STATUS_BYTES) continue;
          parsed = statusFileSchema.parse(
            JSON.parse(await fs.readFile(path, "utf8")),
          );
        } catch {
          // Mid-write partial JSON, an unknown shape, or a rejected token —
          // skip this tick; the writer rewrites the whole file, so the next
          // poll converges.
          continue;
        }
        if (parsed.tool_name !== "bash") {
          // jcode-internal machinery (self-dev builds, communicate) is not
          // the agent's background work.
          if (!skippedTools.has(parsed.tool_name)) {
            skippedTools.add(parsed.tool_name);
            log("info", "ignoring non-bash harness background task kind", {
              toolName: parsed.tool_name,
            });
          }
          continue;
        }

        const { status, error } = mapStatus(parsed);
        const command = parsed.display_name?.trim() || "(background task)";

        // Incremental output: consume what accrued since the last poll,
        // bounded; a runaway writer gets skipped ahead with a marker.
        let outputDelta: string | undefined;
        const outputPath = join(dir, `${parsed.task_id}.output`);
        try {
          // lstat, so a symlinked `.output` is refused rather than followed.
          const stat = await fs.lstat(outputPath);
          if (!stat.isFile()) throw new Error("not a regular file");
          let offset = offsets.get(parsed.task_id) ?? 0;
          if (stat.size > offset) {
            let marker = "";
            if (stat.size - offset > MAX_BACKLOG_BYTES) {
              offset = stat.size - MAX_DELTA_BYTES;
              marker = GAP_MARKER;
            }
            const limit = Math.min(stat.size - offset, MAX_DELTA_BYTES);
            const data = await readSlice(outputPath, offset, limit);
            offsets.set(parsed.task_id, offset + Buffer.byteLength(data));
            if (marker || data) outputDelta = marker + data;
          }
        } catch {
          // No output file (yet) — normal for a task that printed nothing.
        }

        tasks.push({
          ref: parsed.task_id,
          command,
          status,
          ...(parsed.exit_code !== null && parsed.exit_code !== undefined
            ? { exitCode: parsed.exit_code }
            : {}),
          ...(error ? { error } : {}),
          startedAt: parsed.started_at,
          ...(parsed.completed_at ? { endedAt: parsed.completed_at } : {}),
          ...(outputDelta ? { outputDelta } : {}),
          // The CRITICAL mapping: wake ALONE (see the module header).
          wantsWake: parsed.wake,
        });
        // A terminal task's output never grows again — drop its offset so the
        // map cannot accrue an entry per task across a long container life.
        if (status !== "running") offsets.delete(parsed.task_id);
      }
      return tasks;
    },
  };
};
