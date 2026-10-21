import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The supervisor IS the sandbox's lifetime: the container runs exactly as
 * long as this process does. A run that ended must therefore end the process
 * — on every path, not only when Node's event loop happens to be empty.
 *
 * The bug this pins: a supervisor gave up reconnecting, ran its whole
 * shutdown, logged "supervisor exited cleanly" — and kept living, because
 * one handle (a socket whose close never completed) was still referenced.
 * Its sandbox, and everything the sandbox holds, stayed up until something
 * else recreated it.
 *
 * These spawn the REAL entrypoint (stdio transport, fake harness), because
 * the property is the process's, not any function's.
 */

const ENTRY = join(import.meta.dirname, "index.ts");
const EXIT_BUDGET_MS = 10_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Outcome {
  code: number | null;
  /** Still running when the budget ran out (and killed by the test). */
  hung: boolean;
  stderr: string;
}

/** Boot the supervisor, end its input at once, and see whether it exits. */
const runToEnd = async (
  preload?: string,
  env: Record<string, string> = {},
): Promise<Outcome> => {
  const home = mkdtempSync(join(tmpdir(), "ocl-exit-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const args = ["--import", "tsx"];
  if (preload) {
    const file = join(home, "preload.mjs");
    writeFileSync(file, preload);
    args.push("--import", file);
  }
  const child = spawn(process.execPath, [...args, ENTRY], {
    env: {
      ...process.env,
      AGENT_HARNESS: "fake",
      AGENT_HOME_DIR: home,
      // The stdio transport: no runner to dial, whatever the parent has set.
      RUNNER_WS_URL: "",
      HTTPS_PROXY: "",
      RUNNER_PORT_STREAMS: "",
      RUNNER_HOSTED_DESKTOP: "",
      ...env,
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  // EOF on the stdio transport is the run ending (the dev driver's
  // shutdown), the same `null` the ws transport delivers on give-up.
  child.stdin.end();

  return new Promise<Outcome>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, hung: true, stderr });
    }, EXIT_BUDGET_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, hung: false, stderr });
    });
  });
};

describe(
  "a supervisor whose run has ended",
  { timeout: EXIT_BUDGET_MS + 5_000 },
  () => {
    it("exits 0 once its input ends", async () => {
      const outcome = await runToEnd();

      expect(outcome.hung).toBe(false);
      expect(outcome.code).toBe(0);
      expect(outcome.stderr).toContain("supervisor exited cleanly");
    });

    it("exits 0 even when something still holds the event loop open — the leak shape", async () => {
      // A referenced handle that teardown does not own: in the bug it was the
      // runner socket whose close never completed. An interval is the most
      // honest stand-in (nothing in the supervisor knows about it, exactly
      // like the leak). Without an explicit exit this process never ends.
      // MUTATION-PROOF: drop the explicit exit after the run and this hangs.
      const outcome = await runToEnd("setInterval(() => {}, 60_000);\n");

      expect(outcome.stderr).toContain("supervisor exited cleanly");
      expect(outcome.hung).toBe(false);
      expect(outcome.code).toBe(0);
    });
  },
);

// The hosted platform's agent desktop is licensed code the entrypoint loads
// only when the hosted runner turns it on (and carries port streams): a
// self-hosted sandbox never loads it.
describe("the hosted desktop", { timeout: EXIT_BUDGET_MS + 5_000 }, () => {
  it("stays off without the hosted runner's switch", async () => {
    const outcome = await runToEnd(undefined, { RUNNER_PORT_STREAMS: "1" });
    expect(outcome.code).toBe(0);
    expect(outcome.stderr).not.toContain("hosted desktop on");
  });

  it("stays off when the screen cannot be carried (no port streams)", async () => {
    const outcome = await runToEnd(undefined, { RUNNER_HOSTED_DESKTOP: "1" });
    expect(outcome.code).toBe(0);
    expect(outcome.stderr).not.toContain("hosted desktop on");
  });

  it("is loaded on the hosted runner's switch", async () => {
    const outcome = await runToEnd(undefined, {
      RUNNER_HOSTED_DESKTOP: "1",
      RUNNER_PORT_STREAMS: "1",
    });
    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toContain("hosted desktop on");
  });
});
