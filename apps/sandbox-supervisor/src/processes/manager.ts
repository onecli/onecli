import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  MAX_PROCESS_COMMAND_CHARS,
  MAX_PROCESS_NAME_CHARS,
  MAX_PROCESS_TAIL_WIRE_CHARS,
  MAX_WATCH_EXCERPT_CHARS,
  MAX_WATCH_PATTERN_CHARS,
  MAX_WATCH_PROMPT_CHARS,
  MAX_WATCHES_PER_PROCESS_WIRE,
  type HarnessBackgroundTask,
  type ProcessState,
  type SupervisorMessage,
} from "@onecli/agent-protocol";

/**
 * Background processes inside the sandbox (step 10, §3.9).
 *
 * The supervisor is the ONLY thing that can run work in this container, so
 * execution and detection live here; the control plane holds the durable
 * mirror (SandboxProcess/ProcessWatch rows) that drives keep-awake and turn
 * firing. Three physics facts shape everything below:
 *
 * - A process lives at most one container life. The container is destroyed
 *   on every wake, so PIDs are meaningless outside this process's memory and
 *   the control plane's `lost` sweep owns every death we cannot report.
 * - The ws bootstrap token is single-use — a supervisor can NEVER reconnect.
 *   So reliability is periodic unconditional RE-SEND of whole state frames
 *   over the healthy socket (the sweeper below), never re-send-on-reconnect;
 *   the control plane's transition-guarded upserts make duplicates inert.
 * - Spawned children inherit this process's environment, which carries the
 *   gateway proxy + CA variables and placeholder-only credentials — their
 *   egress rides the gateway exactly like the harness's own shell, and
 *   `/bin/sh -c` grants NOTHING the agent does not already have (same
 *   container, same uid). This is why a command string is not an injection
 *   surface here.
 *
 * SECURITY note on patterns: a watch pattern is a LITERAL substring, never a
 * regex — predictable for the model, immune to pathological backtracking on
 * the supervisor's single thread.
 */

/** Availability bounds (the MAX_CRONS_PER_AGENT reasoning — one box). */
export const MAX_PROCESSES_PER_SANDBOX = 5;
export const MAX_WATCHES_PER_PROCESS = 3;
/** Cap on OBSERVED harness-native tasks mirrored as entries. Separate from
 * the process_start cap (observed work must never brick the agent's own
 * tool); keep-awake needs only one running row, so an over-cap task loses
 * nothing but its own row. */
export const MAX_OBSERVED_TASKS = 20;
/** In-memory interleaved stdout+stderr ring, chars (≈ the 64k result cap). */
export const TAIL_BUFFER_CHARS = 64_000;
/** The rolling window a pattern is matched against (joined with each chunk,
 * so a match split across chunk boundaries is still seen). */
const PATTERN_WINDOW_CHARS = 4_096;
/** Watch expiry bounds/default (seconds). */
export const WATCH_EXPIRES_MIN_SECONDS = 60;
export const WATCH_EXPIRES_MAX_SECONDS = 86_400;
export const WATCH_EXPIRES_DEFAULT_SECONDS = 14_400;
export const WATCH_SILENCE_MIN_SECONDS = 5;
export const WATCH_SILENCE_MAX_SECONDS = 86_400;
/** Terminal processes kept for the periodic re-send (FIFO evicted). */
const MAX_RETAINED_TERMINAL = 20;
/** SIGTERM→SIGKILL escalation grace for process_stop. */
const STOP_GRACE_MS = 5_000;

export interface TurnContext {
  conversationId: string;
  /** Absent when the anchor is a CONVERSATION without a live turn — a
   * harness wake request arriving between turns. The wire's context fields
   * are optional either way, and the control plane verifies both. */
  turnId?: string;
}

/**
 * What the turn-end safety net's watch instructs the fired turn to do. The
 * net exists for work the agent left running with NOTHING armed to report
 * it — a completion nobody would ever hear about otherwise (the running row
 * already holds the machine awake; it is the RESULT that evaporates).
 */
export const TURN_END_SAFETY_NET_PROMPT =
  "A background task was still running when your turn ended without any watch on it. Check its outcome (process_status shows its output) and report the result in a line or two — outcome first; your report reaches the chat this task belongs to. If nothing needs reporting, say so briefly.";

export type ToolOutcome = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

export interface ProcessManagerOptions {
  homeDir: string;
  send: (message: SupervisorMessage) => void;
  /** Test seams; production uses the defaults. */
  now?: () => number;
  sweepIntervalMs?: number;
  resendEveryTicks?: number;
  stopGraceMs?: number;
}

export interface ProcessManager {
  start(
    args: { command: string; name?: string },
    context: TurnContext | null,
  ): ToolOutcome;
  status(args: { processId?: string }): ToolOutcome;
  stop(args: { processId: string }): ToolOutcome;
  watch(
    args: {
      processId: string;
      kind: "exit" | "pattern" | "silence";
      pattern?: string;
      silenceSeconds?: number;
      prompt: string;
      expiresInSeconds?: number;
    },
    context: TurnContext | null,
  ): ToolOutcome;
  /**
   * Mirror one OBSERVED harness-native task (step 10 addendum). Creates the
   * entry at first sight (first-seen-terminal legal, the CP law), routes
   * output deltas through the shared tail/pattern/silence path, and applies
   * running→terminal through the shared finalize. A terminal entry is frozen
   * — late snapshots are inert. Returns what the OBSERVER needs to decide
   * the implicit wake watch; `overCap` means the mirror was refused (the
   * observer logs once).
   */
  observeUpsert(
    snapshot: HarnessBackgroundTask,
    context: TurnContext | null,
  ): { created: boolean; hasArmedWatch: boolean; overCap?: true };
  /** Cancel one ARMED watch (armed→canceled + frame) — the wake-revoke
   * surface. Inert for unknown refs or non-armed watches. */
  cancelWatch(processRef: string, watchRef: string): boolean;
  /**
   * The turn-end safety net: arm a default exit-watch on every RUNNING
   * process that has no armed watch, so work the agent left behind reports
   * its outcome instead of completing invisibly. Each watch carries the
   * process's own arm-time context (the chat where it was started);
   * `fallbackContext` — the ending turn's — covers context-less entries.
   * Returns how many were armed; inert when closed.
   */
  armTurnEndSafetyNet(fallbackContext: TurnContext): number;
  /** Orderly teardown: SIGTERM every group (no wait), destroy pipes, stop
   * the sweeper. Sends nothing — after container stop the control plane's
   * lost sweep owns the truth. */
  close(): void;
  /** SYNCHRONOUS best-effort group signal — safe inside a signal handler. */
  killAllSync(signal?: NodeJS.Signals): void;
}

interface WatchEntry {
  ref: string;
  kind: "exit" | "pattern" | "silence";
  pattern?: string;
  silenceSeconds?: number;
  prompt: string;
  status: "armed" | "triggered" | "expired" | "canceled";
  trigger?: "exited" | "matched" | "silent";
  excerpt?: string;
  triggeredAt?: number;
  expiresAt: number;
  context: TurnContext | null;
}

interface ProcessEntry {
  ref: string;
  command: string;
  name?: string;
  status: "running" | "exited" | "stopped";
  exitCode?: number;
  signal?: string;
  startedAt: number;
  endedAt?: number;
  tail: string;
  patternWindow: string;
  lastOutputAt: number;
  stopRequested: boolean;
  child?: ChildProcess;
  watches: WatchEntry[];
  context: TurnContext | null;
  /** True for a mirrored harness-native task: no child handle ever, stop()
   * refuses (the harness owns its lifecycle), excluded from the
   * process_start cap. */
  observed?: true;
}

const clip = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

/** NUL never survives into anything that could land in Postgres text. */
const stripNul = (value: string): string => value.replaceAll("\0", "");

export const createProcessManager = (
  options: ProcessManagerOptions,
): ProcessManager => {
  const now = options.now ?? (() => Date.now());
  const sweepIntervalMs = options.sweepIntervalMs ?? 1_000;
  const resendEveryTicks = options.resendEveryTicks ?? 30;
  const stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;

  const processes = new Map<string, ProcessEntry>();
  let closed = false;
  let tick = 0;

  const frameFor = (entry: ProcessEntry): ProcessState => ({
    ref: entry.ref,
    command: clip(entry.command, MAX_PROCESS_COMMAND_CHARS),
    ...(entry.name && { name: clip(entry.name, MAX_PROCESS_NAME_CHARS) }),
    status: entry.status,
    ...(entry.exitCode !== undefined && { exitCode: entry.exitCode }),
    ...(entry.signal && { signal: clip(entry.signal, 20) }),
    startedAt: new Date(entry.startedAt).toISOString(),
    ...(entry.endedAt !== undefined && {
      endedAt: new Date(entry.endedAt).toISOString(),
    }),
    ...(entry.tail && {
      tail: clip(
        entry.tail.slice(-MAX_PROCESS_TAIL_WIRE_CHARS),
        MAX_PROCESS_TAIL_WIRE_CHARS,
      ),
    }),
    ...(entry.context ?? {}),
    watches: entry.watches.slice(0, MAX_WATCHES_PER_PROCESS_WIRE).map((w) => ({
      ref: w.ref,
      kind: w.kind,
      ...(w.pattern !== undefined && {
        pattern: clip(w.pattern, MAX_WATCH_PATTERN_CHARS),
      }),
      ...(w.silenceSeconds !== undefined && {
        silenceSeconds: w.silenceSeconds,
      }),
      prompt: clip(w.prompt, MAX_WATCH_PROMPT_CHARS),
      status: w.status,
      ...(w.trigger && { trigger: w.trigger }),
      ...(w.excerpt && {
        excerpt: clip(w.excerpt, MAX_WATCH_EXCERPT_CHARS),
      }),
      ...(w.triggeredAt !== undefined && {
        triggeredAt: new Date(w.triggeredAt).toISOString(),
      }),
      expiresAt: new Date(w.expiresAt).toISOString(),
      ...(w.context ?? {}),
    })),
  });

  const sendFrame = (entry: ProcessEntry): void => {
    if (closed) return;
    options.send({ kind: "process.state", process: frameFor(entry) });
  };

  /** A watch trigger is ONE-SHOT: first condition wins, later ones are
   * no-ops, and nothing ever re-arms. */
  const triggerWatch = (
    entry: ProcessEntry,
    watch: WatchEntry,
    trigger: "exited" | "matched" | "silent",
  ): void => {
    if (watch.status !== "armed") return;
    watch.status = "triggered";
    watch.trigger = trigger;
    watch.triggeredAt = now();
    watch.excerpt = stripNul(entry.tail.slice(-MAX_WATCH_EXCERPT_CHARS));
  };

  const finalize = (
    entry: ProcessEntry,
    status: "exited" | "stopped",
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (entry.status !== "running") return;
    entry.status = status;
    if (exitCode !== null) entry.exitCode = exitCode;
    if (signal) entry.signal = signal;
    entry.endedAt = now();
    entry.child = undefined;
    // EVERY armed watch fires on process end, whatever its kind — a watch
    // must never outlive its process armed, and "the process ended before
    // the pattern matched" is exactly what its owner needs to hear.
    for (const watch of entry.watches) triggerWatch(entry, watch, "exited");
    evictRetained();
    sendFrame(entry);
  };

  const evictRetained = (): void => {
    const terminal = [...processes.values()].filter(
      (entry) => entry.status !== "running",
    );
    if (terminal.length <= MAX_RETAINED_TERMINAL) return;
    terminal
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      .slice(0, terminal.length - MAX_RETAINED_TERMINAL)
      .forEach((entry) => processes.delete(entry.ref));
  };

  const onOutput = (entry: ProcessEntry, chunk: Buffer): void => {
    const text = stripNul(chunk.toString("utf8"));
    if (!text) return;
    entry.lastOutputAt = now();
    entry.tail = (entry.tail + text).slice(-TAIL_BUFFER_CHARS);
    // Pattern matching over the rolling window PLUS this chunk, so a match
    // split across chunk boundaries is still seen. Literal substring only.
    const haystack = entry.patternWindow + text;
    let anyTriggered = false;
    for (const watch of entry.watches) {
      if (watch.status !== "armed" || watch.kind !== "pattern") continue;
      if (watch.pattern && haystack.includes(watch.pattern)) {
        triggerWatch(entry, watch, "matched");
        anyTriggered = true;
      }
    }
    entry.patternWindow = haystack.slice(-PATTERN_WINDOW_CHARS);
    if (anyTriggered) sendFrame(entry);
  };

  const sweep = (): void => {
    if (closed) return;
    tick += 1;
    const at = now();
    for (const entry of processes.values()) {
      let changed = false;
      for (const watch of entry.watches) {
        if (watch.status !== "armed") continue;
        if (watch.expiresAt <= at) {
          watch.status = "expired";
          changed = true;
          continue;
        }
        if (
          entry.status === "running" &&
          watch.kind === "silence" &&
          watch.silenceSeconds !== undefined &&
          entry.lastOutputAt + watch.silenceSeconds * 1000 <= at
        ) {
          triggerWatch(entry, watch, "silent");
          changed = true;
        }
      }
      if (changed) sendFrame(entry);
    }
    // The reliability mechanism (see the module header): re-send EVERY held
    // process, terminal included, on the slow clock.
    if (tick % resendEveryTicks === 0) {
      for (const entry of processes.values()) sendFrame(entry);
    }
  };

  // ONE shared sweeper, unref'd (the standing rule: no supervisor handle may
  // be the thing keeping a finished container alive — the transport socket
  // holds the process, so unref'd timers always fire).
  const sweeper = setInterval(sweep, sweepIntervalMs);
  sweeper.unref();

  /**
   * The shared arm path — the `watch` tool and the turn-end safety net both
   * go through it, so one place owns the caps, the arm-on-a-corpse immediate
   * trigger, and the frame.
   */
  const armWatch = (
    entry: ProcessEntry,
    args: {
      kind: "exit" | "pattern" | "silence";
      pattern?: string;
      silenceSeconds?: number;
      prompt: string;
      expiresInSeconds?: number;
    },
    context: TurnContext | null,
  ): ToolOutcome => {
    const armed = entry.watches.filter(
      (watch) => watch.status === "armed",
    ).length;
    if (armed >= MAX_WATCHES_PER_PROCESS) {
      return {
        ok: false,
        error: `This process already has ${MAX_WATCHES_PER_PROCESS} armed watches.`,
      };
    }
    if (entry.watches.length >= MAX_WATCHES_PER_PROCESS_WIRE) {
      return {
        ok: false,
        error: "Too many watches on this process — start a fresh one.",
      };
    }
    const expiresInSeconds = Math.min(
      Math.max(
        args.expiresInSeconds ?? WATCH_EXPIRES_DEFAULT_SECONDS,
        WATCH_EXPIRES_MIN_SECONDS,
      ),
      WATCH_EXPIRES_MAX_SECONDS,
    );
    const watch: WatchEntry = {
      ref: randomUUID(),
      kind: args.kind,
      ...(args.kind === "pattern" && { pattern: args.pattern }),
      ...(args.kind === "silence" && {
        silenceSeconds: args.silenceSeconds,
      }),
      prompt: args.prompt,
      status: "armed",
      expiresAt: now() + expiresInSeconds * 1000,
      context,
    };
    entry.watches.push(watch);
    // Arming on an already-ended process triggers IMMEDIATELY — the
    // status-check-then-arm TOCTOU cannot produce a watch that waits on a
    // corpse.
    if (entry.status !== "running") {
      triggerWatch(entry, watch, "exited");
    }
    sendFrame(entry);
    return {
      ok: true,
      result: {
        watchId: watch.ref,
        expiresAt: new Date(watch.expiresAt).toISOString(),
        note:
          watch.status === "triggered"
            ? "The process had already ended, so this watch fired immediately."
            : "Armed. It fires once, then is done; it also fires if the process ends first, whatever its kind.",
      },
    };
  };

  // The process_start cap counts only OWNED entries: harness-native tasks
  // the observer mirrors must never brick the agent's own tool.
  const ownedRunningCount = (): number =>
    [...processes.values()].filter(
      (entry) => entry.status === "running" && !entry.observed,
    ).length;
  const observedRunningCount = (): number =>
    [...processes.values()].filter(
      (entry) => entry.status === "running" && entry.observed,
    ).length;

  return {
    start(args, context) {
      if (closed) return { ok: false, error: "The agent is shutting down." };
      // Synchronous count-check-then-register: exact, race-free (one
      // supervisor per sandbox, no await between check and set).
      if (ownedRunningCount() >= MAX_PROCESSES_PER_SANDBOX) {
        return {
          ok: false,
          error: `This machine already runs ${MAX_PROCESSES_PER_SANDBOX} background processes — stop one first (process_status lists them).`,
        };
      }
      const ref = randomUUID();
      const entry: ProcessEntry = {
        ref,
        command: args.command,
        ...(args.name && { name: args.name }),
        status: "running",
        startedAt: now(),
        tail: "",
        patternWindow: "",
        lastOutputAt: now(),
        stopRequested: false,
        watches: [],
        context,
      };
      let child: ChildProcess;
      try {
        child = spawn(args.command, {
          shell: "/bin/sh",
          detached: true, // its own process group — stop() signals the GROUP
          stdio: ["ignore", "pipe", "pipe"],
          cwd: options.homeDir,
          env: process.env,
        });
      } catch (error) {
        return { ok: false, error: `Could not start: ${String(error)}` };
      }
      // A running child must never be what holds this process's event loop.
      child.unref();
      entry.child = child;
      processes.set(ref, entry);

      child.stdout?.on("data", (chunk: Buffer) => onOutput(entry, chunk));
      child.stderr?.on("data", (chunk: Buffer) => onOutput(entry, chunk));
      // `exit` records the outcome (may fire before stdio drains); `close`
      // finalizes — stdio has flushed, so the terminal frame carries the
      // complete tail.
      let recorded: {
        code: number | null;
        signal: NodeJS.Signals | null;
      } | null = null;
      child.on("exit", (code, signal) => {
        recorded = { code, signal };
      });
      child.on("close", () => {
        finalize(
          entry,
          entry.stopRequested ? "stopped" : "exited",
          recorded?.code ?? null,
          recorded?.signal ?? null,
        );
      });
      // Spawn-time failure (ENOENT, EMFILE…) surfaces as an event, not a
      // throw; close may never fire, so finalize here.
      child.on("error", (error) => {
        entry.tail = (entry.tail + `\n[spawn error: ${String(error)}]`).slice(
          -TAIL_BUFFER_CHARS,
        );
        finalize(entry, "exited", null, null);
      });

      sendFrame(entry);
      return {
        ok: true,
        result: {
          processId: ref,
          ...(args.name && { name: args.name }),
          startedAt: new Date(entry.startedAt).toISOString(),
          note: "Running in the background. Arm process_watch if you want to be woken when something happens — the machine may otherwise sleep once conversations go idle.",
        },
      };
    },

    status(args) {
      if (args.processId) {
        const entry = processes.get(args.processId);
        if (!entry) {
          return {
            ok: false,
            error: `No process "${args.processId}" on this machine (it may have died with a restart — process_status lists what is known here).`,
          };
        }
        return {
          ok: true,
          result: {
            processId: entry.ref,
            ...(entry.name && { name: entry.name }),
            command: clip(entry.command, 200),
            status: entry.status,
            ...(entry.exitCode !== undefined && { exitCode: entry.exitCode }),
            ...(entry.signal && { signal: entry.signal }),
            startedAt: new Date(entry.startedAt).toISOString(),
            ...(entry.endedAt !== undefined && {
              endedAt: new Date(entry.endedAt).toISOString(),
            }),
            // Bounded well under the 64k result law.
            tail: entry.tail.slice(-48_000),
            watches: entry.watches.map((watch) => ({
              watchId: watch.ref,
              kind: watch.kind,
              status: watch.status,
              ...(watch.trigger && { trigger: watch.trigger }),
              expiresAt: new Date(watch.expiresAt).toISOString(),
            })),
          },
        };
      }
      return {
        ok: true,
        result: [...processes.values()].map((entry) => ({
          processId: entry.ref,
          ...(entry.name && { name: entry.name }),
          command: clip(entry.command, 200),
          status: entry.status,
          ...(entry.exitCode !== undefined && { exitCode: entry.exitCode }),
          startedAt: new Date(entry.startedAt).toISOString(),
          ...(entry.endedAt !== undefined && {
            endedAt: new Date(entry.endedAt).toISOString(),
          }),
          tailEnd: entry.tail.slice(-500),
          watches: entry.watches.map((watch) => ({
            watchId: watch.ref,
            kind: watch.kind,
            status: watch.status,
            expiresAt: new Date(watch.expiresAt).toISOString(),
          })),
        })),
      };
    },

    stop(args) {
      const entry = processes.get(args.processId);
      if (!entry) {
        return { ok: false, error: `No process "${args.processId}".` };
      }
      if (entry.observed && entry.status === "running") {
        // The harness owns this task's lifecycle (we hold no handle to it) —
        // the supervisor never signals another manager's children.
        return {
          ok: false,
          error:
            "This task was started through your own tooling — stop it the same way you started it. It also ends when this machine stops.",
        };
      }
      if (entry.status !== "running" || !entry.child?.pid) {
        return {
          ok: true,
          result: { stopped: entry.ref, note: "It had already ended." },
        };
      }
      entry.stopRequested = true;
      const pid = entry.child.pid;
      // Signal the GROUP (detached spawn = the shell leads its own group):
      // kill(pid) alone would orphan the shell's children mid-pipeline.
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // ESRCH: already gone; close will finalize.
      }
      const escalation = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, stopGraceMs);
      escalation.unref();
      return { ok: true, result: { stopped: entry.ref } };
    },

    watch(args, context) {
      if (closed) return { ok: false, error: "The agent is shutting down." };
      const entry = processes.get(args.processId);
      if (!entry) {
        return { ok: false, error: `No process "${args.processId}".` };
      }
      return armWatch(entry, args, context);
    },

    armTurnEndSafetyNet(fallbackContext) {
      if (closed) return 0;
      let armed = 0;
      for (const entry of processes.values()) {
        if (entry.status !== "running") continue;
        // Any armed watch already guarantees a wake on exit (finalize fires
        // them ALL) — the net exists only for work nothing will report.
        if (entry.watches.some((watch) => watch.status === "armed")) continue;
        const outcome = armWatch(
          entry,
          {
            kind: "exit",
            prompt: TURN_END_SAFETY_NET_PROMPT,
            // The MAX, not the default: a day-long build's report must
            // still land (the observer's implicit-wake choice).
            expiresInSeconds: WATCH_EXPIRES_MAX_SECONDS,
          },
          // The process's own first-sight context is the honest origin —
          // "the chat where the task was started" — and it also keeps a
          // net re-arm from a watch- or cron-sourced turn from pointing
          // the report at a hidden automation conversation. The ending
          // turn's context only covers context-less observed tasks.
          entry.context ?? fallbackContext,
        );
        if (outcome.ok) armed += 1;
      }
      return armed;
    },

    observeUpsert(snapshot, context) {
      if (closed) return { created: false, hasArmedWatch: false };
      let entry = processes.get(snapshot.ref);
      let created = false;
      if (!entry) {
        if (
          snapshot.status === "running" &&
          observedRunningCount() >= MAX_OBSERVED_TASKS
        ) {
          return { created: false, hasArmedWatch: false, overCap: true };
        }
        entry = {
          ref: snapshot.ref,
          command: snapshot.command,
          ...(snapshot.name && { name: snapshot.name }),
          // Created running even for a first-seen-terminal snapshot: the
          // shared finalize below is the ONE place that applies terminal
          // state (watch firing, eviction, the frame), exactly like an owned
          // child's close event.
          status: "running",
          startedAt: Date.parse(snapshot.startedAt) || now(),
          tail: "",
          patternWindow: "",
          lastOutputAt: now(),
          stopRequested: false,
          watches: [],
          context,
          observed: true,
        };
        processes.set(snapshot.ref, entry);
        created = true;
      }
      if (entry.status === "running") {
        if (snapshot.outputDelta) {
          onOutput(entry, Buffer.from(snapshot.outputDelta, "utf8"));
        }
        if (snapshot.name && !entry.name) entry.name = snapshot.name;
        if (snapshot.status !== "running") {
          // Land the failure text in the tail first, so the watch excerpt
          // carries it — then the shared terminal path.
          if (snapshot.error) {
            onOutput(entry, Buffer.from(`\n[task failed: ${snapshot.error}]`));
          }
          finalize(entry, snapshot.status, snapshot.exitCode ?? null, null);
        } else if (created) {
          sendFrame(entry);
        }
      }
      // A terminal entry is frozen — late snapshots (any status) are inert.
      return {
        created,
        hasArmedWatch: entry.watches.some((w) => w.status === "armed"),
      };
    },

    cancelWatch(processRef, watchRef) {
      const entry = processes.get(processRef);
      const watch = entry?.watches.find((w) => w.ref === watchRef);
      if (!entry || !watch || watch.status !== "armed") return false;
      watch.status = "canceled";
      sendFrame(entry);
      return true;
    },

    close() {
      if (closed) return;
      closed = true;
      clearInterval(sweeper);
      for (const entry of processes.values()) {
        if (entry.status === "running" && entry.child?.pid) {
          try {
            process.kill(-entry.child.pid, "SIGTERM");
          } catch {
            // already gone
          }
        }
        // Piped stdio are open handles — without destroying them a live
        // child would hold this process's event loop past the loop's end.
        entry.child?.stdout?.destroy();
        entry.child?.stderr?.destroy();
      }
    },

    killAllSync(signal: NodeJS.Signals = "SIGTERM") {
      // Called from the SIGTERM/SIGINT handler right before process.exit:
      // process.kill is synchronous, so this is legal there. Best-effort —
      // the container is about to die; this is the children's flush chance.
      for (const entry of processes.values()) {
        if (entry.status === "running" && entry.child?.pid) {
          try {
            process.kill(-entry.child.pid, signal);
          } catch {
            // already gone
          }
        }
      }
    },
  };
};
