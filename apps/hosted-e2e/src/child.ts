import { spawn, type ChildProcess } from "node:child_process";

/**
 * Child-process plumbing shared by the gateway and api-server spawners — the
 * gateway-e2e mechanics (log scanner, exit-hook registry, SIGTERM-then-KILL
 * stop) generalized to any service child. Env is always constructed
 * explicitly by the caller, never a `process.env` spread: a dev machine's
 * real cloud credentials leaking into a child is how tests pass locally and
 * fail in CI.
 */

interface LogLine {
  parsed: Record<string, unknown> | null;
  raw: string;
}

export class LogScanner {
  private readonly lines: LogLine[] = [];
  private buffer = "";
  private readonly waiters = new Set<{
    match: (line: Record<string, unknown>) => boolean;
    resolve: (line: Record<string, unknown>) => void;
  }>();

  push(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    for (const raw of parts) {
      if (raw.trim() === "") continue;
      let parsed: Record<string, unknown> | null = null;
      try {
        const value: unknown = JSON.parse(raw);
        if (typeof value === "object" && value !== null) {
          parsed = value as Record<string, unknown>;
        }
      } catch {
        // Non-JSON output (a panic, a stack trace) is still worth keeping.
      }
      this.lines.push({ parsed, raw });
      if (parsed !== null) {
        for (const waiter of this.waiters) {
          if (waiter.match(parsed)) {
            this.waiters.delete(waiter);
            waiter.resolve(parsed);
          }
        }
      }
    }
  }

  find(
    match: (line: Record<string, unknown>) => boolean,
  ): Record<string, unknown> | undefined {
    return (
      this.lines.find((l) => l.parsed !== null && match(l.parsed))?.parsed ??
      undefined
    );
  }

  waitFor(
    match: (line: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const existing = this.find(match);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => {
      this.waiters.add({ match, resolve });
    });
  }

  text(): string {
    return this.lines.map((l) => l.raw).join("\n");
  }
}

export const messageIncludes =
  (needle: string) =>
  (line: Record<string, unknown>): boolean => {
    const message = line["message"] ?? line["msg"];
    return typeof message === "string" && message.includes(needle);
  };

/**
 * Every child spawned and not yet reaped. The scenario's `finally` stops each
 * one, but that block does not run when vitest aborts a timed-out test — the
 * exit hook is the backstop (`exit` handlers must be synchronous, so it
 * signals rather than awaits).
 */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

const installExitHook = (): void => {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of liveChildren) child.kill("SIGKILL");
  });
};

export interface ServiceChild {
  readonly child: ChildProcess;
  readonly logs: LogScanner;
  /** SIGTERM, a short grace, then SIGKILL. Idempotent. */
  stop(): Promise<void>;
}

export const spawnService = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; cwd?: string },
): ServiceChild => {
  installExitHook();
  const logs = new LogScanner();
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env,
    ...(options.cwd !== undefined && { cwd: options.cwd }),
  });
  liveChildren.add(child);
  child.once("close", () => liveChildren.delete(child));
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => logs.push(chunk));
  child.stderr?.on("data", (chunk: string) => logs.push(chunk));

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      child.once("close", () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.kill("SIGTERM");
    });

  return { child, logs, stop };
};

/** Poll an HTTP readiness URL until 200, racing child death and a deadline. */
export const waitForHealthy = async (
  service: ServiceChild,
  url: string,
  label: string,
  timeoutMs = 60_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  service.child.once("close", () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`${label} exited before ready:\n${service.logs.text()}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `${label} did not answer ${url} within ${timeoutMs}ms:\n${service.logs.text()}`,
  );
};
