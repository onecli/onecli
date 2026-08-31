import type { HarnessBackgroundTasks } from "@onecli/agent-protocol";
import { log } from "../log";
import {
  WATCH_EXPIRES_MAX_SECONDS,
  type ProcessManager,
  type TurnContext,
} from "./manager";

/**
 * The harness-native background-task observer (step 10 addendum).
 *
 * The live e2e proved the harness prefers its OWN background tooling and
 * never reaches for process_start — and its native "wake me on completion"
 * runs a harness-internal turn whose report no one ever sees, while the
 * untracked task dies silently at idle-stop. This module is the decided
 * answer: observe, don't override. It polls the adapter's task snapshots and
 * mirrors them through the manager — the SAME entries, frames, rows,
 * keep-awake, lost-sweep, and fire pipeline the platform tools use — so
 * native background work keeps the machine awake and its completion wakes
 * the agent as a real platform turn.
 *
 * The one intent it translates rather than mirrors: a task the agent asked
 * its harness to WAKE it about gets an implicit platform exit-watch, so the
 * wake arrives as a visible turn with a report delivered to the origin chat
 * instead of a harness-internal shadow turn.
 */

/** What the implicit wake watch instructs the fired turn to do. The agent's
 * own session may have already seen the completion (the harness's internal
 * wake), so the prompt asks for a report either way — never a redo. */
export const IMPLICIT_WAKE_PROMPT =
  "A background task you started on this machine has finished. Check its outcome (process_status shows its output) and report the result in a line or two — outcome first; your report reaches the chat this task belongs to. If you already handled this completion, just summarize the outcome.";

export interface ProcessObserverOptions {
  manager: ProcessManager;
  tasks: HarnessBackgroundTasks;
  /** The supervisor's active-turn accessor — first-sight anchoring, exactly
   * like a platform tool call's context. */
  activeTurn: () => TurnContext | null;
  /** Test seam; production uses the default. */
  intervalMs?: number;
}

export interface ProcessObserver {
  /** One observation pass — exposed for tests; production rides the timer. */
  poll(): Promise<void>;
  stop(): void;
}

export const createProcessObserver = (
  options: ProcessObserverOptions,
): ProcessObserver => {
  const intervalMs = options.intervalMs ?? 1_000;

  /** Refs whose terminal state has been applied. The manager evicts old
   * terminal entries while the harness's status file lives on — without this
   * set the next poll would re-create the entry and churn frames forever. */
  const terminalSeen = new Set<string>();
  /** Refs whose wake intent already armed an implicit watch (arm-once), with
   * the watch ref kept for the revoke path. */
  const implicitWatch = new Map<string, string>();
  /** Over-cap and unparseable refs are logged once, never per poll. */
  const warnedRefs = new Set<string>();

  let stopped = false;
  let polling = false;

  const pass = async (): Promise<void> => {
    if (stopped || polling) return; // a slow poll never stacks
    polling = true;
    try {
      const snapshots = await options.tasks.poll();
      for (const snapshot of snapshots) {
        if (terminalSeen.has(snapshot.ref)) continue;

        // The snapshot's own context wins over the active-turn heuristic:
        // between turns there IS no active turn, and during a SIBLING
        // conversation's turn the heuristic would anchor the entry to the
        // wrong chat. Only adapters that truly know the owner set it.
        const context = snapshot.context ?? options.activeTurn();
        const applied = options.manager.observeUpsert(snapshot, context);
        if (applied.overCap) {
          if (!warnedRefs.has(snapshot.ref)) {
            warnedRefs.add(snapshot.ref);
            log("warn", "observed task over the mirror cap; not tracked", {
              ref: snapshot.ref,
            });
          }
          continue;
        }

        if (snapshot.wantsWake) {
          // Any armed watch already guarantees a wake on exit (finalize
          // fires them ALL), so arming another would double-report.
          if (!implicitWatch.has(snapshot.ref) && !applied.hasArmedWatch) {
            const armed = options.manager.watch(
              {
                processId: snapshot.ref,
                kind: "exit",
                // A wake-shaped snapshot may carry its own honest wording
                // (a resolved fan-out await, a message from another agent);
                // the generic prompt covers plain background tasks.
                prompt: snapshot.wakePrompt ?? IMPLICIT_WAKE_PROMPT,
                // The MAX, not the default: a day-long build's wake must
                // still land.
                expiresInSeconds: WATCH_EXPIRES_MAX_SECONDS,
              },
              context,
            );
            const watchId = (armed.result as { watchId?: string } | undefined)
              ?.watchId;
            if (armed.ok && watchId) {
              implicitWatch.set(snapshot.ref, watchId);
            }
          }
        } else {
          // Wake revoked after we armed (the harness honors the FINAL flag;
          // an un-asked wake would diverge visibly) → cancel ours.
          const watchRef = implicitWatch.get(snapshot.ref);
          if (watchRef) {
            options.manager.cancelWatch(snapshot.ref, watchRef);
            implicitWatch.delete(snapshot.ref);
          }
        }

        if (snapshot.status !== "running") {
          terminalSeen.add(snapshot.ref);
          implicitWatch.delete(snapshot.ref); // fired or moot — keep the map bounded
        }
      }
    } catch (error) {
      log("warn", "background-task observation pass failed", {
        error: String(error),
      });
    } finally {
      polling = false;
    }
  };

  // The standing rule: no supervisor handle may hold a finished container's
  // event loop — the transport socket owns process lifetime.
  const timer = setInterval(() => void pass(), intervalMs);
  timer.unref();

  return {
    poll: pass,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
};
