import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eConfig, gatewayBinary, secretEncryptionKey } from "./env.js";
import {
  messageIncludes,
  spawnService,
  type LogScanner,
  type ServiceChild,
} from "./child.js";

/**
 * A per-test gateway, ONPREM edition — the posture this suite exists to
 * prove (`docker compose up`, no Redis, no KMS, no Cognito; local AES via the
 * scenario's shared SECRET_ENCRYPTION_KEY; an unlicensed onprem gateway
 * refuses to even boot with REDIS_HOST set). It binds 0.0.0.0 (all
 * interfaces), which is what lets sandbox CONTAINERS reach a host-spawned
 * gateway through `host.docker.internal`.
 */

const STARTUP_TIMEOUT_MS = 30_000;

export interface GatewayHandle {
  readonly origin: string;
  readonly port: number;
  /** The MITM CA the control plane ships into every sandbox. */
  readonly caPath: string;
  readonly dataDir: string;
  readonly logs: LogScanner;
  stop(): Promise<void>;
}

export interface StartGatewayOptions {
  databaseUrl: string;
  env?: Record<string, string>;
}

export const startGateway = async (
  opts: StartGatewayOptions,
): Promise<GatewayHandle> => {
  const dataDir = mkdtempSync(join(tmpdir(), "onecli-hosted-e2e-gw-"));

  // The licensed HA stores when CI provides a Redis; the in-memory stores
  // otherwise — both are legitimate entitled configurations (see env.ts).
  const config = e2eConfig();
  const redisEnv: Record<string, string> =
    config?.redisHost !== undefined
      ? {
          REDIS_HOST: config.redisHost,
          REDIS_PORT: config.redisPort,
          REDIS_TLS: "false",
        }
      : {};

  const service: ServiceChild = spawnService(
    gatewayBinary(),
    ["--port", "0", "--data-dir", dataDir],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        // The enterprise edition: an entitled self-host — the canonical
        // licensed deployment, matching the gateway-e2e default lane.
        EDITION: "onprem",
        ENTERPRISE_ENABLED: "true",
        DATABASE_URL: opts.databaseUrl,
        SECRET_ENCRYPTION_KEY: secretEncryptionKey(),
        ...redisEnv,
        // The stub upstream's self-signed cert lives on 127.0.0.1 — narrower
        // than the global danger flag, same as gateway-e2e.
        GATEWAY_SKIP_VERIFY_HOSTS: "127.0.0.1",
        APP_URL: "http://127.0.0.1:10254",
        LOG_FORMAT: "json",
        RUST_LOG: process.env.HOSTED_E2E_RUST_LOG ?? "info",
        ...opts.env,
      },
    },
  );

  const fail = (why: string): never => {
    throw new Error(`${why}\n--- gateway logs ---\n${service.logs.text()}`);
  };

  const listening = await Promise.race([
    service.logs.waitFor(messageIncludes("listening for connections")),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), STARTUP_TIMEOUT_MS),
    ),
    new Promise<null>((resolve) =>
      service.child.once("close", () => resolve(null)),
    ),
  ]);
  if (listening === null) {
    return fail("gateway did not report a listening address");
  }

  const boot = service.logs.find(messageIncludes("starting onecli-gateway"));
  const edition = boot?.["edition"];
  if (edition !== undefined && edition !== "Onprem") {
    return fail(`gateway booted as ${String(edition)}, expected Onprem`);
  }

  const addr = listening["addr"];
  const port = Number.parseInt(
    typeof addr === "string" ? (addr.split(":").pop() ?? "") : "",
    10,
  );
  if (!Number.isInteger(port) || port <= 0) {
    return fail(`gateway logged no usable addr: ${JSON.stringify(listening)}`);
  }

  const origin = `http://127.0.0.1:${port}`;
  // Health for real before declaring ready (the log line races the bind).
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`${origin}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) break;
    } catch {
      // Not yet.
    }
    if (Date.now() > deadline) return fail("gateway /healthz never answered");
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    origin,
    port,
    caPath: join(dataDir, "gateway", "ca.pem"),
    dataDir,
    logs: service.logs,
    stop: async () => {
      await service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
};
