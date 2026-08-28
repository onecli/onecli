import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertEdition, gatewayBinary } from "./binary.js";
import { secretEncryptionKey, type E2EConfig } from "./env.js";

/** How a gateway process ended, as observed from outside. */
export interface GatewayExit {
  /** 0 for a clean drain; null when a signal killed it. */
  readonly code: number | null;
  /** e.g. `SIGKILL` when the process never handled the signal; null when it exited itself. */
  readonly signal: NodeJS.Signals | null;
  /** ms from sending the signal to the child's `close` event. */
  readonly durationMs: number;
}

/** A running gateway process under test. */
export interface GatewayHandle {
  readonly port: number;
  /** `http://127.0.0.1:<port>` — the proxy and control-plane origin. */
  readonly origin: string;
  readonly dataDir: string;
  /** Path to the CA the gateway mints MITM leaves with. */
  readonly caPath: string;
  /** Everything the child has written so far, for failure diagnostics. */
  logs(): string;
  /**
   * Wait for a structured log line whose `message` contains `needle`.
   * Resolves immediately when the line has already been written.
   */
  waitForLog(needle: string, timeoutMs?: number): Promise<void>;
  /**
   * Signal the gateway and observe how it exits.
   *
   * Resolves on the child's `close` event — not `exit` — so stdout is fully
   * flushed and `logs()` is complete by the time a test asserts on it. Throws
   * (after a SIGKILL) if the process outlives `timeoutMs`: a drain that busts
   * its deadline should read as exactly that, never as a silent kill.
   */
  terminate(options?: {
    readonly signal?: "SIGTERM" | "SIGINT";
    readonly timeoutMs?: number;
  }): Promise<GatewayExit>;
  /**
   * Teardown fast-kill: SIGTERM with a token grace, then SIGKILL.
   *
   * Deliberately NOT a graceful stop. Ordinary tests must never pay drain
   * tax in teardown — shutdown behavior is asserted through `terminate()`.
   */
  stop(): Promise<void>;
}

/**
 * `APP_URL` for every spawned gateway.
 *
 * Exported so a test asserting on an agent-facing dashboard link compares
 * against the value the gateway was actually given, rather than a second copy
 * of the string that could drift out of step with it.
 */
export const GATEWAY_APP_URL = "http://127.0.0.1:10254";

export interface GatewayOptions {
  readonly databaseUrl: string;
  readonly config: E2EConfig;
  /** Reuse a data dir to exercise CA persistence across a restart. */
  readonly dataDir?: string;
  /** Additional or overriding environment for this instance. */
  readonly env?: Readonly<Record<string, string>>;
  /** The edition the boot line must report (default Onprem — the suite's
   * standard enterprise lane; the cloud lane starts Cloud gateways). */
  readonly expectedEdition?: "Cloud" | "Onprem";
}

interface LogLine {
  readonly parsed: Record<string, unknown> | null;
  readonly raw: string;
}

/** Collects the child's output and lets callers await a matching JSON log line. */
class LogScanner {
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
        // Non-JSON output (a panic, a rustls warning) is still worth keeping.
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

const messageIs =
  (needle: string) =>
  (line: Record<string, unknown>): boolean => {
    const message = line["message"];
    return typeof message === "string" && message.includes(needle);
  };

const STARTUP_TIMEOUT_MS = 30_000;

/**
 * Poll until the gateway's listener refuses new TCP connections.
 *
 * Raw `net.connect`, no bytes written: `throughProxy`/`connectThroughProxy`
 * send a full request first, so through them a half-open accept and a refusal
 * are indistinguishable. Errors other than ECONNREFUSED (a transient reset from
 * a mid-drop backlog SYN) count as "not refused yet" and retry.
 */
export const waitForConnectionRefused = async (
  origin: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const url = new URL(origin);
  const deadline = Date.now() + timeoutMs;

  const attempt = (): Promise<"refused" | "open"> =>
    new Promise((resolve) => {
      const socket = netConnect(Number(url.port), url.hostname);
      socket.once("connect", () => {
        socket.destroy();
        resolve("open");
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        resolve(error.code === "ECONNREFUSED" ? "refused" : "open");
      });
    });

  while (Date.now() < deadline) {
    if ((await attempt()) === "refused") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `gateway at ${origin} was still accepting connections after ${String(timeoutMs)}ms`,
  );
};

/**
 * Every child we have spawned and not yet reaped.
 *
 * The normal path stops each gateway in the scenario's `finally`, but that block
 * does not run when vitest aborts a timed-out test — which leaves a real proxy
 * process running against a database we are about to drop. This registry plus
 * the exit hook below is the backstop; `exit` handlers must be synchronous, so
 * it signals rather than awaiting.
 */
const liveChildren = new Set<{ kill(signal: NodeJS.Signals): boolean }>();
let exitHookInstalled = false;

const installExitHook = (): void => {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of liveChildren) child.kill("SIGKILL");
  });
};

export const startGateway = async (
  opts: GatewayOptions,
): Promise<GatewayHandle> => {
  const { config, databaseUrl } = opts;
  const dataDir =
    opts.dataDir ?? mkdtempSync(join(tmpdir(), "onecli-gateway-e2e-"));

  // An explicit environment, never a `process.env` spread: a developer's local
  // REDIS_PASSWORD or DATABASE_URL would otherwise silently change what is
  // under test.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    // The binary is edition-less; the suite defaults to the ENTERPRISE
    // edition — an entitled self-host (`EDITION=onprem` +
    // `ENTERPRISE_ENABLED=true`), the canonical licensed deployment — so the
    // runtime switch must reach the child (assertEdition guards it did; the
    // unlicensed and cloud lanes override per test).
    EDITION: "onprem",
    ENTERPRISE_ENABLED: "true",
    DATABASE_URL: databaseUrl,
    // The licensed HA stores: multi-instance operation is an entitled
    // feature, and this lane is entitled — so it runs the Redis-backed cache
    // and approval stores, not the in-memory fallback. (The unlicensed lane
    // overrides REDIS_HOST to empty and runs in-memory.)
    REDIS_HOST: config.redisHost,
    REDIS_PORT: config.redisPort,
    // The self-host default is plain TCP; a plain container speaks TCP.
    REDIS_TLS: "false",
    // Local AES-256-GCM — the self-host crypto backend. The fixtures encrypt
    // with the same key (vitest pins it), which is what keeps the TS→Rust
    // 3-part format a real cross-language assertion.
    SECRET_ENCRYPTION_KEY: secretEncryptionKey(),
    // Host-scoped, matched against the port-stripped host — narrower than the
    // global GATEWAY_DANGER_ACCEPT_INVALID_CERTS, so only the stub is exempt.
    GATEWAY_SKIP_VERIFY_HOSTS: "127.0.0.1",
    // Makes agent-facing dashboard links deterministic and silences a boot warning.
    APP_URL: GATEWAY_APP_URL,
    LOG_FORMAT: "json",
    RUST_LOG: process.env.GATEWAY_E2E_RUST_LOG ?? "info",
    ...opts.env,
  };

  // stdin is deliberately closed; stdout/stderr are piped so the child's own
  // account of a failure can be attached to the assertion.
  const child = spawn(gatewayBinary(), ["--port", "0", "--data-dir", dataDir], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const scanner = new LogScanner();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => scanner.push(c));
  child.stderr.on("data", (c: string) => scanner.push(c));

  installExitHook();
  liveChildren.add(child);

  let exited:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    liveChildren.delete(child);
  });

  // `close` fires after `exit`, once stdout/stderr have drained — the moment
  // from which `logs()` is complete. `terminate()` resolves on this, never on
  // `exit`, so a test can assert on the final shutdown log lines race-free.
  let closed:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined;
  const closeWaiters = new Set<
    (result: { code: number | null; signal: NodeJS.Signals | null }) => void
  >();
  child.on("close", (code, signal) => {
    closed = { code, signal };
    for (const waiter of closeWaiters) waiter(closed);
    closeWaiters.clear();
  });

  /** Kill the child and raise, always including its own account of the failure. */
  const failure = (reason: string): Error => {
    child.kill("SIGKILL");
    return new Error(`${reason}\n--- gateway output ---\n${scanner.text()}`);
  };

  // Race readiness against both the timeout and the child dying, so a crash
  // surfaces its own output immediately instead of timing out opaquely.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const listening = scanner.waitFor(messageIs("listening for connections"));
  let bootLine: Record<string, unknown> | undefined;

  while (bootLine === undefined) {
    if (exited !== undefined) {
      throw failure(
        `gateway exited during startup (code=${String(exited.code)} signal=${String(exited.signal)})`,
      );
    }
    if (Date.now() > deadline) {
      throw failure(
        `gateway did not report a listening address within ${STARTUP_TIMEOUT_MS}ms`,
      );
    }
    bootLine = await Promise.race([
      listening,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 100)),
    ]);
  }

  const startLine = scanner.find(messageIs("starting onecli-gateway"));
  if (startLine === undefined) {
    throw failure(
      "gateway never logged its startup line, so its edition could not be verified",
    );
  }
  assertEdition(startLine, opts.expectedEdition ?? "Onprem");

  const addr = bootLine["addr"];
  if (typeof addr !== "string") {
    throw failure(
      `gateway logged a listening line without a usable addr: ${JSON.stringify(bootLine)}`,
    );
  }
  const port = Number.parseInt(addr.split(":").pop() ?? "", 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw failure(
      `could not parse a port out of the gateway's bound address ${addr}`,
    );
  }

  const origin = `http://127.0.0.1:${String(port)}`;

  // The listener is bound before the router is mounted, so also wait for a real
  // 200 from /healthz.
  while (Date.now() < deadline) {
    if (exited !== undefined) {
      throw failure(
        `gateway exited before becoming healthy (code=${String(exited.code)})`,
      );
    }
    try {
      const res = await fetch(`${origin}/healthz`);
      if (res.status === 200) {
        return {
          port,
          origin,
          dataDir,
          caPath: join(dataDir, "gateway", "ca.pem"),
          logs: () => scanner.text(),
          waitForLog: async (needle, timeoutMs = 5_000) => {
            let timer: NodeJS.Timeout | undefined;
            try {
              await Promise.race([
                scanner.waitFor(messageIs(needle)),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => {
                    reject(
                      new Error(
                        `gateway never logged "${needle}" within ${String(timeoutMs)}ms`,
                      ),
                    );
                  }, timeoutMs);
                }),
              ]);
            } finally {
              if (timer !== undefined) clearTimeout(timer);
            }
          },
          terminate: async (options = {}) => {
            const signal = options.signal ?? "SIGTERM";
            const timeoutMs = options.timeoutMs ?? 15_000;
            const startedAt = Date.now();
            if (closed === undefined) child.kill(signal);
            const result = await new Promise<{
              code: number | null;
              signal: NodeJS.Signals | null;
            }>((resolve, reject) => {
              if (closed !== undefined) {
                resolve(closed);
                return;
              }
              const waiter = (r: {
                code: number | null;
                signal: NodeJS.Signals | null;
              }): void => {
                clearTimeout(timer);
                resolve(r);
              };
              const timer = setTimeout(() => {
                closeWaiters.delete(waiter);
                // Report the miss rather than silently escalating: a drain
                // that busts its deadline is a finding, not a cleanup detail.
                child.kill("SIGKILL");
                reject(
                  new Error(
                    `gateway did not exit within ${String(timeoutMs)}ms of ${signal}`,
                  ),
                );
              }, timeoutMs);
              closeWaiters.add(waiter);
            });
            return {
              code: result.code,
              signal: result.signal,
              durationMs: Date.now() - startedAt,
            };
          },
          stop: async () => {
            if (exited !== undefined) return;
            child.kill("SIGTERM");
            // A token grace only. The binary now drains on SIGTERM, and a
            // drain can legitimately take seconds — which ordinary teardown
            // must never pay across 70+ call sites. Tests that care about
            // shutdown behavior use terminate(); this path just needs the
            // process gone, and everything it strands (per-test database,
            // Redis keys, data dir) is torn down right after anyway.
            const stopBy = Date.now() + 250;
            while (exited === undefined && Date.now() < stopBy) {
              await new Promise((r) => setTimeout(r, 25));
            }
            if (exited === undefined) child.kill("SIGKILL");
          },
        };
      }
    } catch {
      // Not accepting yet.
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  throw failure(
    `gateway never answered /healthz with 200 within ${STARTUP_TIMEOUT_MS}ms`,
  );
};
