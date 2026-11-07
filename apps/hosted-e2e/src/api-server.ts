import { join } from "node:path";
import type { GatewayHandle } from "./gateway.js";
import { secretEncryptionKey, type HostedE2EConfig } from "./env.js";
import { spawnService, waitForHealthy, type ServiceChild } from "./child.js";

/**
 * A per-test api-server CHILD — a child on purpose, twice over: `@onecli/db`
 * binds its Prisma client to DATABASE_URL at import (a per-test clone needs a
 * per-test process), and each test's gateway has a fresh port the agent-proxy
 * address must carry. The gateway therefore always spawns FIRST; the API
 * enforces that by taking the handle, not a URL.
 *
 * `ONECLI_AGENT_PROXY_ADDRESS` uses the HOST-GATEWAY name, not 127.0.0.1: the
 * value's one consumer that matters is the sandbox spawn env (`HTTPS_PROXY`),
 * which must resolve FROM INSIDE a container. (The old `GATEWAY_BASE_URL`
 * name keeps working as a permanent read-alias; the suite pins the new one.)
 */

const API_DIR = join(import.meta.dirname, "..", "..", "api-server");

export interface ApiServerHandle {
  readonly origin: string;
  readonly port: number;
  readonly service: ServiceChild;
  stop(): Promise<void>;
}

export interface StartApiServerOptions {
  databaseUrl: string;
  gateway: GatewayHandle;
  runnerToken: string;
  /**
   * Omit (or 0) to let the child bind a port the OS picks and read it back
   * from its "listening" line, as the gateway's `--port 0` is read. Picking a
   * free port up front and handing it over races the child's multi-second
   * boot: anything on the host can take the port in between (EADDRINUSE).
   */
  port?: number;
  config: HostedE2EConfig;
  /** Per-scenario timing overrides (SANDBOX_IDLE_STOP_SECONDS, ...). */
  env?: Record<string, string>;
}

/** How long the child may take to report its bound port. */
const STARTUP_TIMEOUT_MS = 60_000;

const LISTENING_LINE = /api-server listening on port (\d+)/;

export const startApiServer = async (
  opts: StartApiServerOptions,
): Promise<ApiServerHandle> => {
  const service = spawnService(
    join(API_DIR, "node_modules", ".bin", "tsx"),
    ["src/index.ts"],
    {
      cwd: API_DIR,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "test",
        // The enterprise edition, matching the spawned gateway: an entitled
        // self-host, so the licensed control-plane arms (RBAC role resolver,
        // workspace-access bindings) are wired exactly as a licensed
        // deployment wires them.
        EDITION: "onprem",
        ENTERPRISE_ENABLED: "true",
        PORT: String(opts.port ?? 0),
        DATABASE_URL: opts.databaseUrl,
        SECRET_ENCRYPTION_KEY: secretEncryptionKey(),
        BETTER_AUTH_SECRET: "hosted-e2e-better-auth-secret",
        RUNNER_TOKEN: opts.runnerToken,
        // The sandbox-facing gateway address (container-resolvable)…
        ONECLI_AGENT_PROXY_ADDRESS: `${opts.config.hostGatewayHost}:${opts.gateway.port}`,
        // …and the CA file the control plane ships into every sandbox.
        GATEWAY_CA_PEM_FILE: opts.gateway.caPath,
        ...opts.env,
      },
    },
  );

  const fail = (why: string): never => {
    throw new Error(`${why}:\n${service.logs.text()}`);
  };

  const listening = await Promise.race([
    service.logs.waitForRaw((raw) => LISTENING_LINE.test(raw)),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), STARTUP_TIMEOUT_MS),
    ),
    new Promise<null>((resolve) =>
      service.child.once("close", () => resolve(null)),
    ),
  ]);
  if (listening === null) {
    return fail("api-server exited before ready, or never reported its port");
  }
  const port = Number.parseInt(LISTENING_LINE.exec(listening)?.[1] ?? "", 10);
  if (!Number.isInteger(port) || port <= 0) {
    return fail(`api-server logged no usable port: ${listening}`);
  }

  const origin = `http://127.0.0.1:${port}`;
  await waitForHealthy(service, `${origin}/v1/health`, "api-server");

  return {
    origin,
    port,
    service,
    stop: () => service.stop(),
  };
};
