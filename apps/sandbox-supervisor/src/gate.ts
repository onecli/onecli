import { spawn } from "node:child_process";
import { z } from "zod";

/**
 * A scheduled task's GATE: a shell command the supervisor runs before the
 * agent, with no model and no tokens. It answers one question, "is there
 * anything to do?":
 *
 * - exit 0 with empty stdout, or a LAST stdout line that is a JSON object
 *   with `wakeAgent: false`: nothing to do, the run ends quietly. The last
 *   line, not the whole output, so a check may print what it looked at
 *   first (the same contract other agent runtimes document for this gate).
 * - exit 0 with any other stdout: wake the agent and hand it the output, so
 *   it does not re-fetch what the gate already found.
 * - nonzero exit (or timeout): the run fails, and counts toward the
 *   schedule's failure auto-disable like any failed run.
 *
 * Same spawn posture as background processes (processes/manager.ts): the
 * agent's workspace folder as cwd, the environment the agent's own shell
 * gets, and the check leads its own process group, so a timeout ends
 * everything it started, not just the shell.
 */

/** Well under the control plane's stale-dispatch window (90s): a gated turn
 * stays `dispatched` while its gate runs, and one still sitting there past
 * that window would be handed out again. A gate is a cheap check, not work. */
const GATE_TIMEOUT_MS = 30_000;
const GATE_MAX_OUTPUT_BYTES = 1_000_000;
const GATE_ERROR_TAIL_CHARS = 500;

type GateVerdict =
  | { kind: "quiet" }
  | { kind: "wake"; output: string }
  | { kind: "failed"; error: string };

/** The quiet answer: a JSON object whose `wakeAgent` is false (other keys
 * are the check's own business). */
const quietLine = z.looseObject({ wakeAgent: z.literal(false) });

const saysQuiet = (line: string): boolean => {
  try {
    return quietLine.safeParse(JSON.parse(line)).success;
  } catch {
    // Not JSON: plain output wakes the agent with it.
    return false;
  }
};

const verdictOf = (stdout: string): GateVerdict => {
  const output = stdout.trim();
  if (!output) return { kind: "quiet" };
  const lastLine = output.slice(output.lastIndexOf("\n") + 1).trim();
  return saysQuiet(lastLine) ? { kind: "quiet" } : { kind: "wake", output };
};

/** Signal the check's whole group; ESRCH (already gone) is the normal race. */
const killGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
};

export const runGate = (
  command: string,
  cwd: string,
  timeoutMs = GATE_TIMEOUT_MS,
): Promise<GateVerdict> =>
  new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: process.env,
      // Its own process group, so the timeout reaches every child it forked
      // (a pipeline, a backgrounded curl), never only the shell.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    const collect = (append: (chunk: string) => void) => (chunk: Buffer) => {
      if (stdout.length + stderr.length > GATE_MAX_OUTPUT_BYTES) {
        overflow = true;
        killGroup(child.pid, "SIGKILL");
        return;
      }
      append(chunk.toString("utf8"));
    };
    child.stdout.on(
      "data",
      collect((chunk) => (stdout += chunk)),
    );
    child.stderr.on(
      "data",
      collect((chunk) => (stderr += chunk)),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGKILL");
    }, timeoutMs);
    timer.unref();

    const fail = (why: string) => {
      const tail = (stderr || stdout).trim().slice(-GATE_ERROR_TAIL_CHARS);
      resolve({
        kind: "failed",
        error: `The gate command ${why}${tail ? `: ${tail}` : ""}`,
      });
    };
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(`could not start (${error.message})`);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return fail(`timed out after ${timeoutMs / 1000}s`);
      if (overflow) return fail("printed more than the 1 MB a check may");
      if (code !== 0)
        return fail(`exited with ${code ?? signal ?? "an error"}`);
      resolve(verdictOf(stdout));
    });
  });
