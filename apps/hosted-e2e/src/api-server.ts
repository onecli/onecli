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
  port: number;
  config: HostedE2EConfig;
  /** Per-scenario timing overrides (SANDBOX_IDLE_STOP_SECONDS, ...). */
  env?: Record<string, string>;
}

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
        PORT: String(opts.port),
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

  const origin = `http://127.0.0.1:${opts.port}`;
  await waitForHealthy(service, `${origin}/v1/health`, "api-server");

  return {
    origin,
    port: opts.port,
    service,
    stop: () => service.stop(),
  };
};
