import { randomUUID } from "node:crypto";
import type {
  HarnessBackgroundTask,
  HarnessBackgroundTasks,
} from "@onecli/agent-protocol";
import { log } from "../log";

/**
 * The harness's EXTERNAL WAKE requests, mirrored as observed tasks.
 *
 * Under external wake ownership (v0.81+, `JCODE_WAKE_MODE=external`) the
 * daemon never starts turns on its own: a resolved fan-out await, a stalled
 * background task, or a message from another agent surfaces as a typed
 * `wake_requested` event on the session stream instead. This feed converts
 * each event into a synthetic BORN-TERMINAL observed task with wake intent —
 * so the platform's own machinery (observer arm-on-terminal → exit watch →
 * control-plane fire) delivers the wake as a real, visible turn in the
 * conversation the session serves. Zero new wire vocabulary: the synthetic
 * rides the same `process.state` frames as every mirrored task.
 *
 * Two deliberate non-deliveries:
 * - `background_task_completed` is DROPPED here: the bash-registry mirror
 *   (jcode-background.ts) already owns that completion — poll-derived,
 *   durable, with richer context and the real output tail. Forwarding the
 *   event too would double-wake every completed task.
 * - The event is at-most-once and subscriber-or-lost upstream, so this feed
 *   is the fast path, never the guarantee — the turn-end safety net and the
 *   registry/roster mirrors remain the durable backstop.
 *
 * Delivery robustness: entries REPLAY on every poll for a bounded window
 * rather than draining once — the observer's whole pass runs under one
 * try/catch, and a one-shot drain consumed by a failing pass would lose the
 * wake. Replay is inert once applied (the observer's terminal-seen guard and
 * the control plane's terminal freeze both dedupe by ref), and the ref
 * carries per-event entropy so container restarts can never replay a ref
 * into a frozen row.
 */

/** How long an entry keeps replaying before it is presumed applied. */
export const WAKE_REPLAY_MS = 60_000;
/** FIFO bound — a wake storm must never grow the feed without limit. */
export const MAX_PENDING_WAKES = 100;

export interface JcodeWakeRequest {
  reason: string;
  notification: string;
  conversationId: string;
}

/** Reason → what the observed row says and what the fired turn is told. */
const WAKE_SHAPES: Record<string, { label: string; prompt: string }> = {
  background_task_stalled: {
    label: "background task stalled",
    prompt:
      "A background task you started has gone quiet and may be stalled. Check its state (process_status shows its output), unstick it if you can, and report what happened in a line or two — your report reaches the chat this task belongs to.",
  },
  swarm_await_completed: {
    label: "helpers finished",
    prompt:
      "Helper agents you were waiting on have finished. Collect their results (process_status shows each helper and its completion report), do what you promised with them, and reply with a SHORT outcome — a line per helper at most; your reply reaches the chat this work belongs to.",
  },
  communication_delivery: {
    label: "message from another agent",
    prompt:
      "Another agent sent you a message (shown below). Act on it if action is needed and reply with only what the chat should know, briefly.",
  },
};

/** Never silent: a reason this table does not know still wakes, generically. */
const GENERIC_SHAPE = {
  label: "background wake",
  prompt:
    "Your runtime requested a wake-up for the work below. Check its state (process_status shows your background work) and report only what the chat should know, briefly.",
};

/** The one reason another mirror already owns end to end. */
const OWNED_ELSEWHERE = new Set(["background_task_completed"]);

/** Clamp only — control characters are stripped where the text is consumed
 * (the fire-time excerpt path), same as every other mirrored tail. */
const MAX_NOTIFICATION_CHARS = 2_000;

const clampNotification = (raw: string): string =>
  raw.slice(0, MAX_NOTIFICATION_CHARS);

export interface JcodeWakeFeed extends HarnessBackgroundTasks {
  /** Convert one `wake_requested` event into a pending synthetic task. */
  deliver(request: JcodeWakeRequest): void;
}

export const createJcodeWakeFeed = (): JcodeWakeFeed => {
  const pending = new Map<
    string,
    { task: HarnessBackgroundTask; at: number }
  >();

  return {
    deliver(request) {
      if (OWNED_ELSEWHERE.has(request.reason)) return;
      const shape = WAKE_SHAPES[request.reason] ?? GENERIC_SHAPE;
      if (!(request.reason in WAKE_SHAPES)) {
        log("warn", "unknown wake reason; forwarding generically", {
          reason: request.reason,
        });
      }
      if (pending.size >= MAX_PENDING_WAKES) {
        // FIFO: the oldest entry has had the longest replay window already.
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      const ref = `wake:${randomUUID()}`;
      const now = new Date().toISOString();
      pending.set(ref, {
        at: Date.now(),
        task: {
          ref,
          command: `wake request: ${shape.label}`,
          name: shape.label,
          // Born terminal with NO exit code: the trigger sentence then says
          // "the process finished" instead of inventing a code.
          status: "exited",
          startedAt: now,
          endedAt: now,
          // The wake's own text becomes the tail → the watch excerpt → the
          // fired turn's [Recent output:] block.
          outputDelta: clampNotification(request.notification),
          wantsWake: true,
          context: { conversationId: request.conversationId },
          wakePrompt: shape.prompt,
        },
      });
    },

    poll() {
      const cutoff = Date.now() - WAKE_REPLAY_MS;
      for (const [ref, entry] of pending) {
        if (entry.at < cutoff) pending.delete(ref);
      }
      return Promise.resolve([...pending.values()].map((entry) => entry.task));
    },
  };
};
