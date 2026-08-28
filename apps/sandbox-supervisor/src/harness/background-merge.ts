import type {
  HarnessBackgroundTask,
  HarnessBackgroundTasks,
} from "@onecli/agent-protocol";
import { log } from "../log";

/**
 * Compose several background-task feeds into the ONE `backgroundTasks` the
 * observer polls. Exists because jcode has two disjoint task worlds — the
 * bash background registry and the swarm-helper roster — and the observer
 * must stay source-blind (invariant 9: vendor specifics never leave the
 * adapter).
 *
 * Isolation contract: `poll()` never throws, and one failing source never
 * starves the others — a feed that breaks (a wedged socket, a corrupt
 * registry) costs only its own tasks for that tick. Refs are trusted to be
 * disjoint across sources (jcode task ids and jcode session ids), so this is
 * a plain concat, not a merge-by-ref.
 */
export const mergeBackgroundTasks = (
  ...sources: HarnessBackgroundTasks[]
): HarnessBackgroundTasks => {
  /** Failure messages already logged — a stuck source must not spam the 1s
   * clock. Bounded and clipped: message text varies per failure, and this
   * Set lives for the container. */
  const loggedFailures = new Set<string>();
  const MAX_LOGGED_FAILURES = 100;

  return {
    async poll(): Promise<HarnessBackgroundTask[]> {
      const results = await Promise.allSettled(
        sources.map((source) => source.poll()),
      );
      const tasks: HarnessBackgroundTask[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          tasks.push(...result.value);
          continue;
        }
        const message = String(result.reason).slice(0, 300);
        if (
          !loggedFailures.has(message) &&
          loggedFailures.size < MAX_LOGGED_FAILURES
        ) {
          loggedFailures.add(message);
          log("warn", "background-task source failed; skipping this tick", {
            error: message,
          });
        }
      }
      return tasks;
    },
  };
};
